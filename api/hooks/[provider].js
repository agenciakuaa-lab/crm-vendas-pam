// Webhooks: /api/hooks/wa · /api/hooks/rdcrm · /api/hooks/resend · /api/hooks/n8n · /api/hooks/hook
import crypto from 'node:crypto';
import { env, json, hmacHex, safeEqual, saveEvent } from '../_lib.js';

const providerOf = (request) => new URL(request.url).pathname.split('/').filter(Boolean).pop();

// Meta/WhatsApp: confirmação do endereço (GET com hub.challenge)
export function GET(request) {
  const p = providerOf(request), q = new URL(request.url).searchParams;
  if (p === 'wa') {
    const vt = env('WA_VERIFY_TOKEN');
    if (q.get('hub.mode') === 'subscribe' && vt && q.get('hub.verify_token') === vt) return new Response(q.get('hub.challenge'), { status: 200 });
    return json({ error: 'verify token inválido ou WA_VERIFY_TOKEN não configurado' }, 403);
  }
  return json({ ok: true, provider: p, info: 'Envie eventos por POST' });
}

export async function POST(request) {
  const p = providerOf(request);
  const raw = await request.text();
  const h = Object.fromEntries(request.headers);

  if (p === 'wa') {
    const secret = env('WA_APP_SECRET');
    if (!secret) return json({ error: 'WA_APP_SECRET não configurado' }, 503);
    const sig = (h['x-hub-signature-256'] || '').replace(/^sha256=/, '');
    if (!safeEqual(sig, hmacHex(secret, raw))) return json({ error: 'assinatura inválida' }, 401);
  } else if (p === 'resend') {
    const secret = env('RESEND_WEBHOOK_SECRET');
    if (secret) { // assinatura Svix
      const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
      const expected = crypto.createHmac('sha256', key).update(`${h['svix-id']}.${h['svix-timestamp']}.${raw}`).digest('base64');
      const ok = (h['svix-signature'] || '').split(' ').some((s) => safeEqual(s.split(',')[1] || '', expected));
      if (!ok) return json({ error: 'assinatura inválida' }, 401);
    }
  } else if (p === 'hook' || p === 'n8n') {
    const secret = env('CRM_WEBHOOK_SECRET');
    if (!secret) return json({ error: 'CRM_WEBHOOK_SECRET não configurado' }, 503);
    if (!safeEqual(h['x-crm-signature'] || '', hmacHex(secret, raw))) return json({ error: 'assinatura inválida' }, 401);
  } else if (p !== 'rdcrm') {
    return json({ error: 'integração desconhecida' }, 404);
  }

  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { payload = { raw }; }
  try {
    await saveEvent(p, payload, { 'user-agent': h['user-agent'] || null });
  } catch (e) {
    return json({ error: e.message }, 503);
  }
  return json({ ok: true });
}
