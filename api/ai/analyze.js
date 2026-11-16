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
    const { source = 'text', id, text: given, title = '', kind = null, date = null, also = [] } = await request.json();
    let text = given || '', name = title, token = null;
    const fetchText = async (src, fid) => {
      token = token || await googleToken(user.id);
      if (src === 'gmail') {
        const m = await gapi(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${fid}?format=full`);
        return { text: decodeBody(m.payload), subject: (m.payload?.headers || []).find((h) => h.name === 'Subject')?.value || '' };
      }
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fid)}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { const e = new Error(`Não consegui abrir o documento (${r.status})`); e.status = r.status; throw e; }
      return { text: await r.text(), subject: '' };
    };
    if (source === 'gmail' || source === 'drive') {
      const t = await fetchText(source, id); text = t.text; name = name || t.subject;
    }
    // outras fontes da mesma reunião (ex.: resumo SalesBud + anotações do Gemini + transcrição)
    const label = { gmail: 'Resumo por e-mail', drive: 'Documento do Drive' };
    for (const o of (Array.isArray(also) ? also : []).slice(0, 3)) {
      try { const t = await fetchText(o.source, o.id); if (t.text.trim()) text += `\n\n===== ${o.label || label[o.source] || 'Outra fonte'} =====\n${t.text}`; } catch (e) { /* ignora fonte que não abriu */ }
    }
    if (also.length) text = `===== ${label[source] || 'Fonte principal'} =====\n` + text;
    text = text.slice(0, 120000);
    if (!text.trim()) return json({ error: 'Sem texto para analisar' }, 400);
    const deals = await sbAdmin(`/rest/v1/deals?owner_id=eq.${user.id}&select=id,title,companies(name),contacts(name)&limit=300`, { headers: { Prefer: '' } }).catch(() => []);
    const system = `Você é um analista comercial sênior. Vai ler o resumo ou a transcrição de uma reunião de vendas (SalesBud, anotações do Gemini ou transcrição do Meet) e extrair o que um CRM precisa para avançar o negócio.

REGRAS
- Use somente o que está no texto. Não invente nomes, valores, datas ou compromissos. Se não aparecer, use null ou lista vazia.
- Escreva em português do Brasil, frases curtas e objetivas.
- "Nós" = quem vende (o usuário do CRM). "Cliente" = a outra empresa.
- Notas de 0 a 100. Pouca evidência = nota baixa, e diga isso no motivo.
- Escolha "negocio_crm" só se um item da lista abaixo corresponder claramente (mesma empresa ou contato). Senão, null.
- "estagio_sugerido" deve ser exatamente um destes: Lead novo, Qualificação, Diagnóstico, Proposta enviada, Negociação, Ganho, Perdido.
- "temperatura": Quente (quer comprar e tem urgência), Morno (interesse com dúvidas), Frio (pouco interesse ou sem prazo), Gelado (sem fit ou desistiu).
- "mensagem_followup": e-mail curto, cordial e específico da reunião, que recapitule o combinado e proponha o próximo passo com data. Sem assinatura.

RESPONDA SOMENTE COM ESTE JSON:
{"resumo":"2-3 frases com o essencial",
"empresa":null,"contato":null,"participantes":["nome (papel)"],"decisores":["quem decide ou aprova"],
"negocio_crm":null,
"dores":["problema do cliente"],"objetivos":["o que o cliente quer alcançar"],
"orcamento_mencionado":null,"valor_estimado":null,"prazo_mencionado":null,
"objecoes":[{"objecao":"...","resposta_sugerida":"..."}],
"compromissos":[{"quem":"nós|cliente|nome","o_que":"...","quando":"data ou null"}],
"sinais":[{"tipo":"compra|dor|objecao|risco","texto":"curto"}],
"vale_a_pena":{"nota":0,"rotulo":"frase curta","motivo":"1-2 frases"},
"termometro":{"orcamento":0,"autoridade":0,"necessidade":0,"prazo":0,"fit":0},
"temperatura":"Quente|Morno|Frio|Gelado","estagio_sugerido":"...",
"proximo_passo":{"quando":"Hoje|Amanhã|D+N","canal":"E-mail|WhatsApp|Ligação|Reunião","acao":"curta"},
"cadencia":[{"quando":"D+N","canal":"...","acao":"..."}],
"mensagem_followup":"..."}
Até 4 itens por lista.

NEGÓCIOS DO CRM (título | empresa | contato):
${JSON.stringify((deals || []).map((d) => `${d.title} | ${d.companies?.name || ''} | ${d.contacts?.name || ''}`)).slice(0, 20000)}`;
    const { text: out, model } = await gemini({ system, contents: [{ role: 'user', parts: [{ text: `Título: ${name}\n\n${text.slice(0, 100000)}` }] }], json: true });
    let data;
    try { data = JSON.parse(out.replace(/^```json\s*|```$/g, '')); } catch { return json({ error: 'A IA respondeu fora do formato. Tente de novo.', raw: out.slice(0, 500) }, 502); }
    // guarda a análise no banco (cria a conversa se ainda não existir)
    if (id && (source === 'gmail' || source === 'drive')) {
      const fp = `${source}:${id}`, uid = user.id;
      const deal = data.negocio_crm ? (deals || []).find((d) => d.title === data.negocio_crm) : null;
      const analysis = { ...data, model, analyzed_at: new Date().toISOString() };
      const row = {
        owner_id: uid, file_path: fp, kind: kind || (source === 'drive' ? 'meet' : (/^\s*O resumo do seu call/i.test(name) ? 'salesbud' : 'gemini_email')),
        summary: name || data.resumo, transcript: { text: text.slice(0, 50000), analysis }, signals: data.sinais || [],
        worth_score: data.vale_a_pena?.nota ?? null, worth_label: data.vale_a_pena?.rotulo ?? null, next_steps: data.cadencia || [],
        ...(deal ? { deal_id: deal.id } : {}), ...(date ? { occurred_at: date } : {})
      };
      try {
        const ex = await sbAdmin(`/rest/v1/conversations?owner_id=eq.${uid}&file_path=eq.${encodeURIComponent(fp)}&select=id`, { headers: { Prefer: '' } });
        if (ex && ex.length) await sbAdmin(`/rest/v1/conversations?id=eq.${ex[0].id}`, { method: 'PATCH', body: JSON.stringify(row) });
        else await sbAdmin('/rest/v1/conversations', { method: 'POST', body: JSON.stringify(row) });
      } catch (e) { console.log('[ai/analyze] não salvou', e.message); }
    }
    return json({ ...data, model });
  } catch (e) {
    console.log('[ai/analyze]', e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}
