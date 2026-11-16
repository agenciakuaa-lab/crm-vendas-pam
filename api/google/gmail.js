// GET  /api/google/gmail                  → e-mails de clientes (sem resumos, promoções e automáticos)
// GET  /api/google/gmail?source=summaries  → resumos do SalesBud e anotações do Gemini
// GET  /api/google/gmail?id=…     → corpo completo de um e-mail
// POST /api/google/gmail          → responde na mesma conversa {threadId, messageId, to, subject, body}
import { json, userFromRequest, sbAdmin } from '../_lib.js';
import { googleToken, gapi } from '../_google.js';

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

export async function GET(request) {
  try {
    const { user, token } = await ctx(request);
    const sp = new URL(request.url).searchParams;
    const id = sp.get('id');
    const days = Math.min(90, Number(sp.get('days')) || 30);
    const want = sp.get('source'); // summaries | salesbud | gemini → resumos ; vazio → e-mails de clientes
    if (want) {
      const parts = [];
      if (want !== 'gemini') parts.push('subject:"O resumo do seu call chegou"');
      if (want !== 'salesbud') parts.push('subject:"Anotações"');
      const q = encodeURIComponent(`newer_than:${days}d {${parts.join(' ')}}`);
      const list = await gapi(token, `${G}/messages?maxResults=60&q=${q}`);
      const msgs = await Promise.all((list.messages || []).map((m) => gapi(token, `${G}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`).catch(() => null)));
      const out = msgs.filter(Boolean).map((m) => {
        const subject = hdr(m, 'Subject');
        const type = SALESBUD.test(subject) ? 'salesbud' : GEMINI.test(subject) ? 'gemini' : null;
        const from = parseFrom(hdr(m, 'From'));
        return type && { id: m.id, threadId: m.threadId, messageId: hdr(m, 'Message-ID'), type, fromName: from.name, fromEmail: from.email, subject, snippet: m.snippet, date: new Date(Number(m.internalDate)).toISOString(), unread: (m.labelIds || []).includes('UNREAD') };
      }).filter(Boolean).filter((m) => want === 'summaries' || m.type === want);
      return json({ messages: out, total: out.length });
    }
    // e-mails de clientes: sem resumos, promoções, redes sociais, atualizações, fóruns e envios automáticos
    const contacts = await sbAdmin(`/rest/v1/contacts?owner_id=eq.${user.id}&select=email&email=not.is.null`, { headers: { Prefer: '' } }).catch(() => []);
    const known = new Set((contacts || []).map((c) => (c.email || '').toLowerCase()).filter(Boolean));
    const q = encodeURIComponent(`newer_than:${days}d -from:me -category:promotions -category:social -category:updates -category:forums -subject:"O resumo do seu call chegou" -subject:"Anotações"`);
    const list = await gapi(token, `${G}/messages?maxResults=80&q=${q}`);
    const msgs = await Promise.all((list.messages || []).map((m) => gapi(token, `${G}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence&metadataHeaders=In-Reply-To&metadataHeaders=Message-ID&metadataHeaders=Auto-Submitted`).catch(() => null)));
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
    return json({ messages: out, total: out.length, hidden });
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
