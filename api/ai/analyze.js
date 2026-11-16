// POST /api/ai/analyze {source:'gmail'|'drive'|'text', id?, text?, title?}
// → resumo, sinais, "vale a pena", termômetro, próximo passo e cadência (JSON)
import { json, userFromRequest, sbAdmin } from '../_lib.js';
import { googleToken, gapi } from '../_google.js';
import { gemini } from './_gemini.js';

export const maxDuration = 60;

function decodeBody(p) {
  if (!p) return '';
  if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
  for (const part of p.parts || []) { const t = decodeBody(part); if (t) return t; }
  if (p.mimeType === 'text/html' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  return '';
}

export async function POST(request) {
  try {
    const user = await userFromRequest(request);
    if (!user) return json({ error: 'Faça login no CRM' }, 401);
    const { source = 'text', id, text: given, title = '' } = await request.json();
    let text = given || '', name = title;
    if (source === 'gmail' || source === 'drive') {
      const token = await googleToken(user.id);
      if (source === 'gmail') {
        const m = await gapi(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
        text = decodeBody(m.payload); name = name || (m.payload?.headers || []).find((h) => h.name === 'Subject')?.value || '';
      } else {
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return json({ error: `Não consegui abrir o documento (${r.status})` }, r.status);
        text = await r.text();
      }
    }
    if (!text.trim()) return json({ error: 'Sem texto para analisar' }, 400);
    const deals = await sbAdmin(`/rest/v1/deals?owner_id=eq.${user.id}&select=title,companies(name),contacts(name)&limit=300`, { headers: { Prefer: '' } }).catch(() => []);
    const system = `Você analisa reuniões de vendas para um CRM. Responda SOMENTE com JSON válido neste formato:
{"resumo":"2-3 frases","empresa":"nome da empresa cliente ou null","contato":"nome do cliente ou null","negocio_crm":"título exato de um negócio da lista que corresponda, ou null",
"sinais":[{"tipo":"compra|dor|objecao|risco","texto":"curto"}],
"vale_a_pena":{"nota":0-100,"rotulo":"frase curta","motivo":"1-2 frases"},
"termometro":{"orcamento":0-100,"autoridade":0-100,"necessidade":0-100,"prazo":0-100,"fit":0-100},
"proximo_passo":{"quando":"Hoje|Amanhã|D+N","canal":"E-mail|WhatsApp|Ligação|Reunião","acao":"curta"},
"cadencia":[{"quando":"D+N","canal":"...","acao":"..."}],
"mensagem_followup":"texto curto e cordial para enviar ao cliente, em português"}
Baseie tudo no texto. Se faltar informação, use notas mais baixas e diga no motivo. Até 4 sinais e 4 passos de cadência.
Negócios do CRM: ${JSON.stringify((deals || []).map((d) => `${d.title} | ${d.companies?.name || ''} | ${d.contacts?.name || ''}`)).slice(0, 20000)}`;
    const { text: out, model } = await gemini({ system, contents: [{ role: 'user', parts: [{ text: `Título: ${name}\n\n${text.slice(0, 60000)}` }] }], json: true });
    let data;
    try { data = JSON.parse(out.replace(/^```json\s*|```$/g, '')); } catch { return json({ error: 'A IA respondeu fora do formato. Tente de novo.', raw: out.slice(0, 500) }, 502); }
    // guarda a análise na conversa importada, se existir
    if (id && (source === 'gmail' || source === 'drive')) {
      await sbAdmin(`/rest/v1/conversations?owner_id=eq.${user.id}&file_path=eq.${source}:${id}`, { method: 'PATCH', body: JSON.stringify({ signals: data.sinais, worth_score: data.vale_a_pena?.nota, worth_label: data.vale_a_pena?.rotulo, next_steps: data.cadencia }) }).catch(() => {});
    }
    return json({ ...data, model });
  } catch (e) {
    console.log('[ai/analyze]', e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}
