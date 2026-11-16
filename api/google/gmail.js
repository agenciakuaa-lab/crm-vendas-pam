// GET  /api/google/gmail          → e-mails recentes, separados em estratégicos e automáticos
// GET  /api/google/gmail?id=…     → corpo completo de um e-mail
// POST /api/google/gmail          → responde na mesma conversa {threadId, messageId, to, subject, body}
import { json, userFromRequest, sbAdmin } from '../_lib.js';
import { googleToken, gapi } from '../_google.js';

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const AUTO_DOMAINS = /(pipedrive|rdstation|rd\.services|calendly|notion|linkedin|facebook|facebookmail|meta|instagram|hubspot|mailchimp|brevo|sendinblue|resend|n8n|vercel|github|supabase|google|youtube|accounts\.|stripe|asaas|paypal|zoom|slack|atlassian|canva|lovable|semrush|metricool|typefully)\./i;
const AUTO_LOCAL = /^(no-?reply|do-?not-?reply|notifications?|notificacoes|alerts?|mailer-daemon|news(letter)?|marketing|info|updates|billing|faturamento|suporte|support)@/i;

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

export async function GET(request) {
  try {
    const { user, token } = await ctx(request);
    const sp = new URL(request.url).searchParams;
    const id = sp.get('id');
    if (sp.get('source') === 'salesbud') {
      const q = encodeURIComponent('from:salesbud newer_than:60d');
      const list = await gapi(token, `${G}/messages?maxResults=30&q=${q}`);
      const items = await Promise.all((list.messages || []).map((m) => gapi(token, `${G}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`).catch(() => null)));
      return json({ messages: items.filter(Boolean).map((m) => ({ id: m.id, threadId: m.threadId, subject: hdr(m, 'Subject') || 'Reunião SalesBud', snippet: m.snippet, date: new Date(Number(m.internalDate)).toISOString() })) });
    }
    if (id) {
      const m = await gapi(token, `${G}/messages/${id}?format=full`);
      return json({ id, threadId: m.threadId, body: decodeBody(m.payload).slice(0, 20000), messageId: hdr(m, 'Message-ID') });
    }
    // contatos do CRM: e-mail de contato conhecido vira prioridade
    const contacts = await sbAdmin(`/rest/v1/contacts?owner_id=eq.${user.id}&select=email,name&email=not.is.null`, { headers: { Prefer: '' } }).catch(() => []);
    const known = new Set((contacts || []).map((c) => (c.email || '').toLowerCase()).filter(Boolean));

    const q = encodeURIComponent('in:inbox newer_than:14d -category:promotions -category:social -from:me');
    const list = await gapi(token, `${G}/messages?maxResults=40&q=${q}`);
    const ids = (list.messages || []).map((m) => m.id);
    const msgs = await Promise.all(ids.map((mid) => gapi(token, `${G}/messages/${mid}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe&metadataHeaders=Message-ID&metadataHeaders=Precedence`).catch(() => null)));

    const out = msgs.filter(Boolean).map((m) => {
      const from = parseFrom(hdr(m, 'From'));
      const reasons = [];
      let auto = false;
      if (hdr(m, 'List-Unsubscribe')) { auto = true; reasons.push('tem link de descadastro (lista ou newsletter)'); }
      if (AUTO_LOCAL.test(from.email)) { auto = true; reasons.push('remetente automático'); }
      if (AUTO_DOMAINS.test(from.email.split('@')[1] || '')) { auto = true; reasons.push('notificação de ferramenta'); }
      if (/bulk|list/i.test(hdr(m, 'Precedence'))) { auto = true; reasons.push('envio em massa'); }
      const isContact = known.has(from.email);
      if (isContact) { auto = false; reasons.unshift('contato do CRM'); }
      if (!auto && !isContact) reasons.push('pessoa escrevendo diretamente para você');
      const unread = (m.labelIds || []).includes('UNREAD');
      if (unread && !auto) reasons.push('ainda não lido');
      return {
        id: m.id, threadId: m.threadId, messageId: hdr(m, 'Message-ID'),
        fromName: from.name, fromEmail: from.email, subject: hdr(m, 'Subject') || '(sem assunto)',
        snippet: m.snippet, date: new Date(Number(m.internalDate)).toISOString(),
        strategic: !auto, isContact, unread, reasons
      };
    });
    return json({ messages: out, total: out.length, strategic: out.filter((x) => x.strategic).length });
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
