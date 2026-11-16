// POST /api/google/sync {from:'2026-10-01', to:'2026-10-31', wipeSample:false}  (ou {days:7})
// Importa da conta Google conectada: reuniões da Agenda viram contatos, empresas, negócios e atividades;
// resumos do SalesBud, anotações do Gemini (e-mail) e transcrições do Drive viram conversas
import { json, userFromRequest, sbAdmin } from '../_lib.js';
import { googleToken, gapi, inBatches } from '../_google.js';

export const maxDuration = 60;
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PUBLIC = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|bol|uol|terra|ig|globo|protonmail|msn)\./i;
const AUTO_DOMAINS = /(pipedrive|rdstation|rd\.services|calendly|notion|linkedin|facebook|facebookmail|meta|instagram|hubspot|mailchimp|brevo|sendinblue|resend|n8n|vercel|github|supabase|google|youtube|stripe|asaas|paypal|zoom|slack|atlassian|canva|lovable|semrush|metricool|typefully|salesbud|apple|microsoft|amazon|mercadolivre|nubank|itau|bradesco|santander|caixa)\./i;
const AUTO_LOCAL = /^(no-?reply|do-?not-?reply|notifications?|notificacoes|alerts?|mailer-daemon|news(letter)?|marketing|info|updates|billing|faturamento|suporte|support|contato|hello|ola|equipe|team)@/i;
const SEED = ['Clínica Vitta','Imobiliária Costa Sul','Pousada Mar Azul','Andrade Advocacia','Rede Farma+','Construtora Horizonte','Academia Pulse','Grupo Litoral','Café Garopaba','Contabilidade Prisma','Hotel Imbituba Bay','EdTech Saber+','Ótica Visão','Studio Pilates Core','Auto Peças SC'];

const hdr = (m, n) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || '';
const parseAddr = (v) => (v || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((p) => { const m = p.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/); return m ? { name: (m[1].trim() || m[2]), email: m[2].trim().toLowerCase() } : { name: p.trim(), email: p.trim().toLowerCase() }; }).filter((a) => /@/.test(a.email));
const domainOf = (e) => (e.split('@')[1] || '').toLowerCase();
const pretty = (email, name) => (!name || name.includes('@')) ? email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || email : name;
const companyName = (email, person) => {
  const d = domainOf(email);
  if (PUBLIC.test(d)) return pretty(email, person);
  const root = d.replace(/^(mail|email|contato|www)\./, '').split('.')[0];
  return root.charAt(0).toUpperCase() + root.slice(1);
};
const q = (s) => encodeURIComponent(s);
async function inChunks(items, n, fn) { const out = []; for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn))); return out; }
const sel = (path) => sbAdmin(path, { headers: { Prefer: '' } });
const ins = (table, rows) => rows.length ? sbAdmin(`/rest/v1/${table}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows) }) : [];

export async function POST(request) {
  const t0 = Date.now();
  try {
    const user = await userFromRequest(request);
    if (!user) return json({ error: 'Faça login no CRM' }, 401);
    const uid = user.id;
    const body = await request.json().catch(() => ({}));
    const wipeSample = !!body.wipeSample;
    const until = body.to ? new Date(`${body.to}T23:59:59-03:00`) : new Date();
    const since = body.from ? new Date(`${body.from}T00:00:00-03:00`) : new Date(Date.now() - (Number(body.days) || 7) * 864e5);
    const days = Math.max(1, Math.round((until - since) / 864e5));
    const gd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '/');
    const gwin = `after:${gd(new Date(since.getTime() - 864e5))} before:${gd(new Date(until.getTime() + 864e5))}`;
    const token = await googleToken(uid);
    const profile = await gapi(token, `${G}/profile`);
    const me = profile.emailAddress.toLowerCase(), myDomain = domainOf(me);
    const internal = (e) => e === me || (!PUBLIC.test(myDomain) && domainOf(e) === myDomain) || /calendar\.google\.com$|resource\./.test(e);
    const stats = { removidos_exemplo: 0, emails_lidos: 0, reunioes_lidas: 0, contatos: 0, empresas: 0, negocios: 0, atividades: 0, conversas: 0 };

    // 0) remove dados de exemplo
    if (wipeSample) {
      const comps = await sel(`/rest/v1/companies?owner_id=eq.${uid}&select=id,name`);
      const ids = (comps || []).filter((c) => SEED.includes(c.name)).map((c) => c.id);
      if (ids.length) {
        const list = `(${ids.join(',')})`;
        await sbAdmin(`/rest/v1/deals?owner_id=eq.${uid}&company_id=in.${list}`, { method: 'DELETE' });
        await sbAdmin(`/rest/v1/contacts?owner_id=eq.${uid}&company_id=in.${list}`, { method: 'DELETE' });
        await sbAdmin(`/rest/v1/companies?owner_id=eq.${uid}&id=in.${list}`, { method: 'DELETE' });
        stats.removidos_exemplo = ids.length;
      }
    }

    // 1) coleta: Gmail recebidos, enviados e Agenda
    const people = new Map(); // email → {name, events:[]}
    const add = (email, name, ev) => {
      if (!email || internal(email)) return;
      const p = people.get(email) || { name: pretty(email, name), events: [] };
      if (name && !name.includes('@') && p.name === pretty(email, '')) p.name = name;
      p.events.push(ev); people.set(email, p);
    };
    let items = [], pageToken = '';
    do {
      const cal = await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({ timeMin: since.toISOString(), timeMax: (until > new Date() ? new Date() : until).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250', ...(pageToken ? { pageToken } : {}) })}`);
      items = items.concat(cal.items || []); pageToken = cal.nextPageToken || '';
    } while (pageToken && items.length < 2500);
    const events = items.filter((e) => e.status !== 'cancelled' && e.start?.dateTime);
    stats.reunioes_lidas = events.length;
    stats.emails_lidos = 0;
    const eventByTitle = new Map();
    for (const e of events) {
      const ext = (e.attendees || []).filter((a) => !a.self && !a.resource && a.email && !internal(a.email.toLowerCase()) && a.responseStatus !== 'declined');
      if (ext.length) eventByTitle.set((e.summary || '').toLowerCase().trim(), ext.map((a) => a.email.toLowerCase()));
      for (const a of ext) add(a.email.toLowerCase(), a.displayName, { kind: 'meet', key: `gcal:${e.id}:${a.email.toLowerCase()}`, at: e.start.dateTime, title: `Reunião: ${e.summary || '(sem título)'}`, detail: e.hangoutLink ? 'Google Meet' : (e.location || '') });
    }

    // 2) empresas, contatos e negócios
    const comps = await sel(`/rest/v1/companies?owner_id=eq.${uid}&select=id,name`);
    const compByName = new Map((comps || []).map((c) => [c.name.toLowerCase(), c.id]));
    const cts = await sel(`/rest/v1/contacts?owner_id=eq.${uid}&select=id,email,company_id`);
    const ctByEmail = new Map((cts || []).filter((c) => c.email).map((c) => [c.email.toLowerCase(), c]));
    const dls = await sel(`/rest/v1/deals?owner_id=eq.${uid}&select=id,company_id,stage_id`);
    const dealByComp = new Map((dls || []).filter((d) => d.company_id).map((d) => [d.company_id, d]));

    const newComps = [...new Set([...people].map(([e, p]) => companyName(e, p.name)))].filter((n) => !compByName.has(n.toLowerCase()));
    for (const c of await ins('companies', newComps.map((name) => ({ owner_id: uid, name })))) compByName.set(c.name.toLowerCase(), c.id);
    stats.empresas = newComps.length;

    const newCts = [...people].filter(([e]) => !ctByEmail.has(e)).map(([e, p]) => ({
      owner_id: uid, email: e, name: p.name, company_id: compByName.get(companyName(e, p.name).toLowerCase()),
      source: p.events.some((x) => x.kind === 'meet') ? 'Agenda Google' : 'Gmail',
      lead_score: p.events.some((x) => x.kind === 'meet') ? 72 : (p.events.some((x) => x.kind === 'in') && p.events.some((x) => x.kind === 'out')) ? 65 : p.events.some((x) => x.kind === 'in') ? 55 : 50
    }));
    for (const c of await ins('contacts', newCts)) ctByEmail.set(c.email, c);
    stats.contatos = newCts.length;

    const byComp = new Map();
    for (const [e, p] of people) { const cid = compByName.get(companyName(e, p.name).toLowerCase()); const arr = byComp.get(cid) || []; arr.push([e, p]); byComp.set(cid, arr); }
    const newDeals = [];
    for (const [cid, list] of byComp) {
      if (!cid || dealByComp.has(cid)) continue;
      const evs = list.flatMap(([, p]) => p.events);
      const meet = evs.some((x) => x.kind === 'meet'), inb = evs.some((x) => x.kind === 'in'), out = evs.some((x) => x.kind === 'out');
      const last = evs.map((x) => x.at).sort().pop();
      const main = list.sort((a, b) => b[1].events.length - a[1].events.length)[0];
      const compName = [...compByName].find(([, id]) => id === cid)?.[0] || '';
      newDeals.push({
        owner_id: uid, title: `Oportunidade · ${main[1].name === compName ? main[1].name : compName.replace(/^./, (c) => c.toUpperCase())}`,
        company_id: cid, contact_id: ctByEmail.get(main[0])?.id, stage_id: (Date.now() - new Date(last).getTime() > 90 * 864e5) ? 7 : meet ? 3 : (inb && out) ? 2 : 1, value: 0,
        lost_reason: (Date.now() - new Date(last).getTime() > 90 * 864e5) ? 'Sem atividade há mais de 90 dias (importado do histórico)' : null,
        score: meet ? 72 : (inb && out) ? 65 : inb ? 55 : 50, source: meet ? 'Agenda Google' : 'Gmail',
        next_action: meet ? 'Enviar próximo passo da reunião' : inb && !out ? 'Responder e qualificar' : out && !inb ? 'Follow-up do e-mail enviado' : 'Qualificar e definir valor',
        next_action_at: new Date().toISOString().slice(0, 10), last_activity_at: last
      });
    }
    for (const d of await ins('deals', newDeals)) dealByComp.set(d.company_id, d);
    stats.negocios = newDeals.length;

    // 3) atividades (sem duplicar)
    const prev = await sel(`/rest/v1/activities?owner_id=eq.${uid}&occurred_at=gte.${new Date(since.getTime() - 864e5).toISOString()}&occurred_at=lte.${new Date(until.getTime() + 864e5).toISOString()}&select=source`);
    const seen = new Set((prev || []).map((a) => a.source));
    const acts = [];
    for (const [e, p] of people) {
      const ct = ctByEmail.get(e), deal = ct && dealByComp.get(ct.company_id);
      for (const ev of p.events) {
        if (seen.has(ev.key)) continue; seen.add(ev.key);
        acts.push({ owner_id: uid, deal_id: deal?.id || null, contact_id: ct?.id || null, type: ev.kind === 'meet' ? 'meeting' : 'email', title: ev.title.slice(0, 200), detail: `${p.name} · ${e}${ev.detail ? ' · ' + ev.detail : ''}`, by_ai: true, source: ev.key, occurred_at: ev.at });
      }
    }
    for (let i = 0; i < acts.length; i += 200) await ins('activities', acts.slice(i, i + 200));
    stats.atividades = acts.length;

    // 4) conversas: transcrições do Gemini (Drive) e SalesBud (Gmail)
    const convPrev = await sel(`/rest/v1/conversations?owner_id=eq.${uid}&select=file_path`);
    const convSeen = new Set((convPrev || []).map((c) => c.file_path));
    const convs = [];
    const dq = [`mimeType='application/vnd.google-apps.document'`, 'trashed=false', `modifiedTime > '${since.toISOString()}'`, `modifiedTime < '${until.toISOString()}'`, "(name contains 'Transcri' or name contains 'transcri' or name contains 'Transcript' or name contains 'Anotações' or name contains 'Gemini')"].join(' and ');
    const files = await gapi(token, `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q: dq, pageSize: '100', fields: 'files(id,name,modifiedTime)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`).catch(() => ({ files: [] }));
    for (const f of files.files || []) {
      if (convSeen.has(`drive:${f.id}`) || Date.now() - t0 > 45000) continue;
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
      const text = r.ok ? (await r.text()).slice(0, 50000) : '';
      const base = f.name.replace(/\s*[-–]\s*(Transcri[çc][ãa]o|Transcript|Anotações do Gemini|Notes by Gemini).*$/i, '').toLowerCase().trim();
      const att = [...eventByTitle].find(([t]) => t && (base.includes(t) || t.includes(base)))?.[1] || [];
      const ct = att.map((e) => ctByEmail.get(e)).find(Boolean), deal = ct && dealByComp.get(ct.company_id);
      convs.push({ owner_id: uid, deal_id: deal?.id || null, kind: /gemini|anota/i.test(f.name) ? 'gemini_notes' : 'meet', file_path: `drive:${f.id}`, summary: f.name, transcript: { text }, occurred_at: f.modifiedTime });
    }
    const sumList = await gapi(token, `${G}/messages?maxResults=200&q=${q(`${gwin} {subject:"O resumo do seu call chegou" subject:"Anotações"}`)}`).catch(() => ({}));
    const dec = (p) => { if (!p) return ''; if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8'); for (const x of p.parts || []) { const t = dec(x); if (t) return t; } if (p.mimeType === 'text/html' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' '); return ''; };
    for (const m of sumList.messages || []) {
      if (convSeen.has(`gmail:${m.id}`) || Date.now() - t0 > 50000) continue;
      const full = await gapi(token, `${G}/messages/${m.id}?format=full`).catch(() => null); if (!full) continue;
      const subject = hdr(full, 'Subject');
      const kind = /^\s*O resumo do seu call chegou!?/i.test(subject) ? 'salesbud' : /^\s*Anotações\s*:/i.test(subject) ? 'gemini_email' : null;
      if (!kind) continue;
      stats.emails_lidos++;
      const title = subject.replace(/^\s*(O resumo do seu call chegou!?|Anotações\s*:)\s*/i, '').replace(/^["“”]|["“”]$/g, '').toLowerCase();
      const att = [...eventByTitle].find(([t]) => t && title && (title.includes(t) || t.includes(title.split(/\s+\d/)[0])))?.[1] || [];
      const ct = att.map((e) => ctByEmail.get(e)).find(Boolean), deal = ct && dealByComp.get(ct.company_id);
      convs.push({ owner_id: uid, deal_id: deal?.id || null, kind, file_path: `gmail:${m.id}`, summary: subject, transcript: { text: dec(full.payload).slice(0, 50000) }, occurred_at: new Date(Number(full.internalDate)).toISOString() });
    }
    await ins('conversations', convs);
    stats.conversas = convs.length;

    await sbAdmin('/rest/v1/integrations?on_conflict=owner_id,provider', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ owner_id: uid, provider: 'google', status: 'on', last_sync_at: new Date().toISOString() }) });
    console.log('[sync]', me, JSON.stringify(stats), `${Date.now() - t0}ms`);
    return json({ ok: true, conta: me, dias: days, de: since.toISOString().slice(0, 10), ate: until.toISOString().slice(0, 10), incompleto: Date.now() - t0 > 45000, ...stats, ms: Date.now() - t0 });
  } catch (e) {
    console.log('[sync] erro', e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}
