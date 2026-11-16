// GET  /api/google/gmail          → e-mails estratégicos: resumos do SalesBud e anotações do Gemini
// GET  /api/google/gmail?id=…     → corpo completo de um e-mail
// POST /api/google/gmail          → responde na mesma conversa {threadId, messageId, to, subject, body}
import { json, userFromRequest, sbAdmin } from '../_lib.js';
import { googleToken, gapi } from '../_google.js';

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';

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
    const { token } = await ctx(request);
    const sp = new URL(request.url).searchParams;
    const id = sp.get('id');
    const days = Math.min(90, Number(sp.get('days')) || 30);
    const want = sp.get('source'); // salesbud | gemini | (vazio = os dois)
    const parts = [];
    if (!want || want === 'salesbud') parts.push('subject:"O resumo do seu call chegou"');
    if (!want || want === 'gemini') parts.push('subject:"Anotações"');
    const q = encodeURIComponent(`newer_than:${days}d {${parts.join(' ')}}`);
    const list = await gapi(token, `${G}/messages?maxResults=60&q=${q}`);
    const msgs = await Promise.all((list.messages || []).map((m) => gapi(token, `${G}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`).catch(() => null)));
    const out = msgs.filter(Boolean).map((m) => {
      const subject = hdr(m, 'Subject');
      const type = /^\s*O resumo do seu call chegou!?/i.test(subject) ? 'salesbud' : /^\s*Anotações\s*:/i.test(subject) ? 'gemini' : null;
      const from = parseFrom(hdr(m, 'From'));
      return type && { id: m.id, threadId: m.threadId, messageId: hdr(m, 'Message-ID'), type, fromName: from.name, fromEmail: from.email, subject, snippet: m.snippet, date: new Date(Number(m.internalDate)).toISOString(), unread: (m.labelIds || []).includes('UNREAD') };
    }).filter(Boolean).filter((m) => !want || m.type === want);
    return json({ messages: out, total: out.length });
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
