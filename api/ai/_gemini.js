// Gemini: usa o Flash mais recente da chave; se estiver sobrecarregado, tenta de novo e cai para o próximo Flash
import { env } from '../_lib.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
let cachedList = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function modelList() {
  if (env('GEMINI_MODEL')) return [env('GEMINI_MODEL')];
  if (cachedList) return cachedList;
  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': env('GEMINI_API_KEY') } });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error('Gemini: ' + (j.error?.message || r.status)), { status: 502 });
  const names = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const flash = names.filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort((a, b) => ver(b) - ver(a));
  const lite = names.filter((n) => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n)).sort((a, b) => ver(b) - ver(a));
  const latest = names.filter((n) => /^gemini-flash(-lite)?-latest$/.test(n));
  cachedList = [...flash.slice(0, 3), ...latest, ...lite.slice(0, 1)];
  if (!cachedList.length) cachedList = ['gemini-flash-latest'];
  return cachedList;
}

const busy = (status, msg) => status === 429 || status === 503 || status === 500 || /high demand|overloaded|unavailable|try again/i.test(msg || '');

export async function gemini({ system, contents, json = false }) {
  const key = env('GEMINI_API_KEY');
  if (!key) throw Object.assign(new Error('Preencha GEMINI_API_KEY na Vercel'), { status: 503 });
  const body = JSON.stringify({
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {})
  });
  let lastErr = 'sem resposta';
  for (const model of await modelList()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`${BASE}/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
        if (text) return { text, model };
        lastErr = 'resposta vazia';
        break;
      }
      lastErr = j.error?.message || `erro ${r.status}`;
      if (r.status === 404) { cachedList = null; break; }
      if (!busy(r.status, lastErr)) throw Object.assign(new Error('Gemini: ' + lastErr), { status: 502 });
      await sleep(1200 * (attempt + 1));
    }
  }
  throw Object.assign(new Error('O Gemini está com muita demanda agora. Tente de novo em 1 minuto.'), { status: 503, detail: lastErr });
}
