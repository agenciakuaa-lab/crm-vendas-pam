// Gemini: escolhe sozinho o modelo Flash mais recente disponível na chave (ou GEMINI_MODEL, se definido)
import { env } from '../_lib.js';

let cached = null;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function pickModel() {
  if (env('GEMINI_MODEL')) return env('GEMINI_MODEL');
  if (cached) return cached;
  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': env('GEMINI_API_KEY') } });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error('Gemini: ' + (j.error?.message || r.status)), { status: 502 });
  const ok = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini-\d+(\.\d+)?-flash$/.test(n) || /^gemini-\d+(\.\d+)?-flash-latest$/.test(n));
  const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  ok.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
  cached = ok[0] || 'gemini-flash-latest';
  return cached;
}

export async function gemini({ system, contents, json = false }) {
  const key = env('GEMINI_API_KEY');
  if (!key) throw Object.assign(new Error('Preencha GEMINI_API_KEY na Vercel'), { status: 503 });
  const model = await pickModel();
  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {})
  };
  const r = await fetch(`${BASE}/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { if (r.status === 404) cached = null; throw Object.assign(new Error('Gemini: ' + (j.error?.message || r.status)), { status: 502 }); }
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return { text, model };
}
