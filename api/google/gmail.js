// GET  /api/google/gmail                  → e-mails de clientes (sem resumos, promoções e automáticos)
// GET  /api/google/gmail?source=summaries  → resumos do SalesBud e anotações do Gemini
// GET  /api/google/gmail?id=…     → corpo completo de um e-mail
// POST /api/google/gmail          → responde na mesma conversa {threadId, messageId, to, subject, body}
import { json, userFromRequest, sbAdmin } from '../_lib.js';
import { googleToken, gapi, inBatches } from '../_google.js';

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';

const SALESBUD = /^\s*O resumo do seu call chegou!?/i;
const GEMINI = /^\s*Anotações\s*:/i;
const AUTO_DOMAINS = /(pipedrive|rdstation|rd\.services|calendly|notion|linkedin|facebook|facebookmail|meta|instagram|hubspot|mailchimp|brevo|sendinblue|resend|n8n|vercel|github|supabase|google|youtube|accounts\.|stripe|asaas|paypal|zoom|slack|atlassian|canva|lovable|semrush|metricool|typefully|salesbud|apple|microsoft|amazon|mercadolivre|nubank|itau|bradesco|santander|caixa|ifood|uber)\./i;
const AUTO_LOCAL = /^(no-?reply|do-?not-?reply|notifications?|notificacoes|notificacao|alerts?|mailer-daemon|postmaster|news(letter)?|marketing|updates|billing|faturamento|cobranca|nfe|nota\.?fiscal)@/i;
const hdr = (m, n) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || '';
const parseFrom = (v) => { const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/); return m ? { name: m[1].trim() || m[2], email: m[2].toLowerCase() } : { name: v, email: v.toLowerCase() }; };
function decodeBody(p) {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
  for (const part of p.parts || []) { const t = decodeBody(part); if (t) return t; }
  if (p.mimeType === 'text/html' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').trim();
  return '';
}

async function ctx(request) {
  const user = await userFromRequest(request);
  if (!user) { const e = new Error('Faça login no CRM'); e.status = 401; throw e; }
  return { user, token: await googleToken(user.id) };
}

const SINCE = '2026-09-01';
async function listIds(token, query, max) {
  const ids = []; let pageToken = '';
  do {
    const j = await gapi(token, `${G}/messages?maxResults=100&q=${encodeURIComponent(query)}${pageToken ? '&pageToken=' + pageToken : ''}`);
    ids.push(...(j.messages || []).map((m) => m.id));
    pageToken = j.nextPageToken || '';
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

export async function GET(request) {
  try {
    const { user, token } = await ctx(request);
    const sp = new URL(request.url).searchParams;
    const id = sp.get('id');
    // período: desde 01/09/2026 por padrão (ou ?since=AAAA-MM-DD)
    const since = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('since') || '') ? sp.get('since') : SINCE;
    const after = `after:${since.replace(/-/g, '/')}`;
    const want = sp.get('source'); // summaries | salesbud | gemini → resumos ; vazio → e-mails de clientes
    if (want) {
      const parts = [];
      if (want !== 'gemini') parts.push('subject:"O resumo do seu call chegou"');
      if (want !== 'salesbud') parts.push('subject:"Anotações"');
      const ids = await listIds(token, `${after} {${parts.join(' ')}}`, 300);
      const msgs = await inBatches(ids, 10, (id) => gapi(token, `${G}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`).catch(() => null));
      const out = msgs.filter(Boolean).map((m) => {
        const subject = hdr(m, 'Subject');
        const type = SALESBUD.test(subject) ? 'salesbud' : GEMINI.test(subject) ? 'gemini' : null;
        const from = parseFrom(hdr(m, 'From'));
        return type && { id: m.id, threadId: m.threadId, messageId: hdr(m, 'Message-ID'), type, fromName: from.name, fromEmail: from.email, subject, snippet: m.snippet, date: new Date(Number(m.internalDate)).toISOString(), unread: (m.labelIds || []).includes('UNREAD') };
      }).filter(Boolean).filter((m) => want === 'summaries' || m.type === want);
      return json({ messages: out, total: out.length, since });
    }
    // e-mails de clientes: sem resumos, promoções, redes sociais, atualizações, fóruns e envios automáticos
    const contacts = await sbAdmin(`/rest/v1/contacts?owner_id=eq.${user.id}&select=email&email=not.is.null`, { headers: { Prefer: '' } }).catch(() => []);
    const known = new Set((contacts || []).map((c) => (c.email || '').toLowerCase()).filter(Boolean));
    const ids = await listIds(token, `${after} -from:me -category:promotions -category:social -category:updates -category:forums -subject:"O resumo do seu call chegou" -subject:"Anotações"`, 400);
    const msgs = await inBatches(ids, 10, (id) => gapi(token, `${G}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence&metadataHeaders=In-Reply-To&metadataHeaders=Message-ID&metadataHeaders=Auto-Submitted`).catch(() => null));
    let hidden = 0;
    const out = [];
    for (const m of msgs.filter(Boolean)) {
      const from = parseFrom(hdr(m, 'From')), subject = hdr(m, 'Subject');
      const auto = hdr(m, 'List-Unsubscribe') || /bulk|list|junk/i.test(hdr(m, 'Precedence')) || /auto-/i.test(hdr(m, 'Auto-Submitted')) || AUTO_LOCAL.test(from.email) || AUTO_DOMAINS.test(from.email.split('@')[1] || '') || SALESBUD.test(subject) || GEMINI.test(subject);
      const isContact = known.has(from.email);
      if (auto && !isContact) { hidden++; continue; }
      const isReply = !!hdr(m, 'In-Reply-To') || /^\s*(re|res|resp|enc|fw|fwd)\s*:/i.test(subject);
      out.push({ id: m.id, threadId: m.threadId, messageId: hdr(m, 'Message-ID'), fromName: from.name, fromEmail: from.email, subject: subject || '(sem assunto)', snippet: m.snippet, date: new Date(Number(m.internalDate)).toISOString(), isContact, isReply, unread: (m.labelIds || []).includes('UNREAD') });
    }
    return json({ messages: out, total: out.length, hidden, since });
  } catch (e) {
    console.log('[google]', new URL(request.url).pathname, e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}

export async function POST(request) {
  try {
    const { token } = await ctx(request);
    const { threadId, messageId, to, subject, body } = await request.json();
    if (!to || !body) return json({ error: 'Informe destinatário e mensagem' }, 400);
    const subj = subject && !/^re:/i.test(subject) ? `Re: ${subject}` : (subject || '');
    const lines = [
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subj).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      ...(messageId ? [`In-Reply-To: ${messageId}`, `References: ${messageId}`] : []),
      '',
      body
    ];
    const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
    const sent = await gapi(token, `${G}/messages/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) });
    return json({ ok: true, id: sent.id, threadId: sent.threadId });
  } catch (e) {
    console.log('[google]', new URL(request.url).pathname, e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}
