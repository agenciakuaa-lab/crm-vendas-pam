// Funções de servidor do CRM · lê as chaves das variáveis de ambiente da Vercel
import crypto from 'node:crypto';

export const PLACEHOLDER = 'PREENCHER';
export const env = (k) => {
  const v = process.env[k];
  return v && v !== PLACEHOLDER ? v : null;
};

// Quais variáveis cada integração usa (req = obrigatória)
export const KEYS = {
  supabase: [['SUPABASE_URL', 1], ['SUPABASE_SECRET_KEY', 1]],
  google: [['GOOGLE_CLIENT_ID', 1], ['GOOGLE_CLIENT_SECRET', 1], ['GMAIL_PUBSUB_TOPIC', 0]],
  wa: [['WA_PHONE_NUMBER_ID', 1], ['WA_BUSINESS_ACCOUNT_ID', 1], ['WA_ACCESS_TOKEN', 1], ['WA_APP_SECRET', 1], ['WA_VERIFY_TOKEN', 1]],
  resend: [['RESEND_API_KEY', 1], ['RESEND_FROM', 1], ['RESEND_WEBHOOK_SECRET', 0]],
  rdcrm: [['RD_CRM_TOKEN', 0], ['RD_CRM_CLIENT_ID', 0], ['RD_CRM_CLIENT_SECRET', 0]],
  claude: [['ANTHROPIC_API_KEY', 1]],
  gemini: [['GEMINI_API_KEY', 1]],
  stt: [['TRANSCRIBE_PROVIDER', 1], ['TRANSCRIBE_API_KEY', 1]],
  n8n: [['N8N_URL', 1], ['N8N_API_KEY', 1]],
  hook: [['CRM_WEBHOOK_SECRET', 1]],
  internal: [['OAUTH_STATE_SECRET', 1]]
};

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

export const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Supabase com a secret key (só no servidor; ignora RLS)
export async function sbAdmin(path, init = {}) {
  const url = env('SUPABASE_URL'), key = env('SUPABASE_SECRET_KEY');
  if (!url || !key) throw new Error('SUPABASE_SECRET_KEY não configurada na Vercel');
  const r = await fetch(`${url}${path}`, {
    ...init,
    headers: { apikey: key, 'content-type': 'application/json', Prefer: 'return=minimal', ...(init.headers || {}) }
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 || r.headers.get('content-length') === '0' ? null : r.json().catch(() => null);
}

// Descobre o usuário pelo token de login do Supabase enviado pelo navegador
export async function userFromRequest(request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const url = env('SUPABASE_URL'), pub = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!token || !url || !pub) return null;
  const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: pub, Authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}

export async function saveEvent(provider, payload, headers) {
  await sbAdmin('/rest/v1/webhook_events', { method: 'POST', body: JSON.stringify({ provider, payload, headers }) });
}
