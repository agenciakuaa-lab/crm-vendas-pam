// Login do Conector Google
// POST /api/oauth/google (com o token do Supabase) → devolve a URL de autorização do Google
// GET  /oauth/google?code=…&state=… → troca o código por tokens e guarda no Supabase
import { env, json, hmacHex, safeEqual, sbAdmin, userFromRequest } from '../_lib.js';

const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/meetings.space.readonly',
  'https://www.googleapis.com/auth/spreadsheets'
];
const redirectUri = (request) => `${new URL(request.url).origin}/oauth/google`;

export async function POST(request) {
  const cid = env('GOOGLE_CLIENT_ID'), stateSecret = env('OAUTH_STATE_SECRET');
  if (!cid || !env('GOOGLE_CLIENT_SECRET')) return json({ error: 'Preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET na Vercel' }, 503);
  if (!stateSecret) return json({ error: 'OAUTH_STATE_SECRET não configurado' }, 503);
  const user = await userFromRequest(request);
  if (!user) return json({ error: 'Faça login no CRM primeiro' }, 401);
  const payload = `${user.id}.${Date.now()}`;
  const state = `${Buffer.from(payload).toString('base64url')}.${hmacHex(stateSecret, payload)}`;
  const q = new URLSearchParams({
    client_id: cid, redirect_uri: redirectUri(request), response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    state, login_hint: user.email || ''
  });
  return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const back = (msg) => Response.redirect(`${new URL(request.url).origin}/app?google=${encodeURIComponent(msg)}#integracoes`, 302);
  if (q.get('error')) return back(q.get('error'));
  const [b64, sig] = (q.get('state') || '').split('.');
  const payload = b64 ? Buffer.from(b64, 'base64url').toString() : '';
  const stateSecret = env('OAUTH_STATE_SECRET');
  if (!stateSecret || !safeEqual(sig || '', hmacHex(stateSecret, payload))) return back('estado_invalido');
  const [userId, ts] = payload.split('.');
  if (Date.now() - Number(ts) > 15 * 60 * 1000) return back('expirado');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: q.get('code') || '', client_id: env('GOOGLE_CLIENT_ID') || '', client_secret: env('GOOGLE_CLIENT_SECRET') || '',
      redirect_uri: redirectUri(request), grant_type: 'authorization_code'
    })
  });
  const tok = await r.json();
  if (!r.ok) return back(tok.error || 'falha_token');

  try {
    await sbAdmin('/rest/v1/integration_tokens?on_conflict=owner_id,provider', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        owner_id: userId, provider: 'google', access_token: tok.access_token,
        refresh_token: tok.refresh_token || null, scope: tok.scope,
        expires_at: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString()
      })
    });
    await sbAdmin('/rest/v1/integrations?on_conflict=owner_id,provider', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ owner_id: userId, provider: 'google', status: 'on', last_sync_at: new Date().toISOString() })
    });
  } catch (e) {
    return back('erro_banco');
  }
  return back('ok');
}
