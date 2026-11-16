// Acesso às APIs do Google com o token guardado no Supabase (renova sozinho)
import { env, sbAdmin } from './_lib.js';

export async function googleToken(userId) {
  const rows = await sbAdmin(`/rest/v1/integration_tokens?owner_id=eq.${userId}&provider=eq.google&select=*`, { headers: { Prefer: '' } });
  const t = rows && rows[0];
  if (!t) { const e = new Error('Conta Google não conectada'); e.status = 409; throw e; }
  if (t.access_token && t.expires_at && new Date(t.expires_at).getTime() - Date.now() > 60_000) return t.access_token;
  if (!t.refresh_token) { const e = new Error('Conexão com o Google expirou. Clique em Conectar conta Google de novo.'); e.status = 401; throw e; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), refresh_token: t.refresh_token, grant_type: 'refresh_token' })
  });
  const j = await r.json();
  if (!r.ok) {
    const e = new Error(j.error === 'invalid_grant' ? 'Conexão com o Google expirou (modo de teste dura 7 dias). Clique em Conectar conta Google de novo.' : 'Falha ao renovar acesso do Google: ' + (j.error || r.status));
    e.status = 401; throw e;
  }
  await sbAdmin(`/rest/v1/integration_tokens?owner_id=eq.${userId}&provider=eq.google`, {
    method: 'PATCH', body: JSON.stringify({ access_token: j.access_token, expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() })
  });
  return j.access_token;
}

export async function gapi(token, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error?.message || `Google ${r.status}`); e.status = r.status; throw e; }
  return j;
}
