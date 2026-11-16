// POST /api/ai/chat {messages:[{role:'user'|'model', text}]} → gerente comercial IA com os dados do CRM
import { json, userFromRequest, sbAdmin } from '../_lib.js';
import { gemini } from './_gemini.js';

export const maxDuration = 60;
const sel = (p) => sbAdmin(p, { headers: { Prefer: '' } });

export async function POST(request) {
  try {
    const user = await userFromRequest(request);
    if (!user) return json({ error: 'Faça login no CRM' }, 401);
    const { messages = [] } = await request.json();
    const uid = user.id;
    const [deals, acts, goals, convs] = await Promise.all([
      sel(`/rest/v1/deals?owner_id=eq.${uid}&select=title,value,probability,score,source,next_action,next_action_at,last_activity_at,lost_reason,stages(name),companies(name),contacts(name,email)&order=last_activity_at.desc&limit=200`),
      sel(`/rest/v1/activities?owner_id=eq.${uid}&select=type,title,detail,occurred_at&order=occurred_at.desc&limit=60`),
      sel(`/rest/v1/goals?owner_id=eq.${uid}&select=period_start,period_end,amount&order=period_start.desc&limit=1`),
      sel(`/rest/v1/conversations?owner_id=eq.${uid}&select=kind,summary,occurred_at,worth_score,analysis:transcript->analysis&order=occurred_at.desc&limit=60`)
    ]);
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    const ctx = {
      hoje: today,
      meta: goals?.[0] || null,
      negocios: (deals || []).map((d) => ({ negocio: d.title, empresa: d.companies?.name, contato: d.contacts?.name, estagio: d.stages?.name, valor: Number(d.value), prob: d.probability, temperatura_score: d.score, origem: d.source, proxima_acao: d.next_action, data_acao: d.next_action_at, dias_sem_atividade: Math.floor((Date.now() - new Date(d.last_activity_at)) / 864e5), motivo_perda: d.lost_reason })),
      atividades_recentes: acts || [],
      reunioes_analisadas: (convs || []).filter((c) => c.analysis).map((c) => { const a = c.analysis; return { titulo: c.summary, data: c.occurred_at, empresa: a.empresa, contato: a.contato, resumo: a.resumo, nota: a.vale_a_pena?.nota, temperatura: a.temperatura, estagio_sugerido: a.estagio_sugerido, valor_estimado: a.valor_estimado, proximo_passo: a.proximo_passo, compromissos: a.compromissos, objecoes: (a.objecoes || []).map((o) => o.objecao), sinais: (a.sinais || []).map((x) => x.tipo + ': ' + x.texto) }; })
    };
    const system = `Você é o gerente comercial IA do CRM de vendas de ${user.email}. Responda em português do Brasil, direto e prático, de forma clara e organizada. Pode usar **negrito**, títulos curtos e listas com "-". Seja objetivo (até ~20 linhas, salvo se pedirem mais).
Use SOMENTE os dados do CRM abaixo. Se algo não estiver nos dados, diga que não tem essa informação no CRM. Não invente valores, nomes ou datas.
Temperatura: score >= 80 quente, 65-79 morno, 50-64 frio, < 50 gelado. Priorize por: temperatura, probabilidade, valor e dias sem atividade. Use também as reuniões analisadas (compromissos, objeções, próximo passo) para recomendar ações.
DADOS DO CRM (JSON):
${JSON.stringify(ctx).slice(0, 120000)}`;
    const contents = messages.slice(-12).map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text).slice(0, 4000) }] }));
    if (!contents.length || contents[contents.length - 1].role !== 'user') return json({ error: 'Envie uma pergunta' }, 400);
    const { text, model } = await gemini({ system, contents });
    return json({ text, model });
  } catch (e) {
    console.log('[ai/chat]', e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}
