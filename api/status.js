// GET /api/status → quais chaves já foram preenchidas na Vercel (nunca devolve os valores)
import { KEYS, env, json } from './_lib.js';

export function GET() {
  const vars = {};
  for (const list of Object.values(KEYS)) for (const [k] of list) vars[k] = !!env(k);
  return json({ vars, deployedAt: process.env.VERCEL_GIT_COMMIT_SHA || null });
}
