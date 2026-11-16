// GET /api/google/transcripts        → transcrições e anotações do Meet salvas no Drive (desde 01/09/2026)
// GET /api/google/transcripts?id=…   → texto completo de uma transcrição
import { json, userFromRequest } from '../_lib.js';
import { googleToken, gapi } from '../_google.js';

export async function GET(request) {
  try {
    const user = await userFromRequest(request);
    if (!user) return json({ error: 'Faça login no CRM' }, 401);
    const token = await googleToken(user.id);
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return json({ error: `Não consegui abrir o documento (${r.status})` }, r.status);
      const text = (await r.text()).slice(0, 60000);
      return json({ id, text });
    }
    const since = new Date('2026-09-01T00:00:00-03:00').toISOString();
    const q = [
      "mimeType='application/vnd.google-apps.document'", 'trashed=false', `modifiedTime > '${since}'`,
      "(name contains 'Transcri' or name contains 'transcri' or name contains 'Transcript' or name contains 'Anotações' or name contains 'Notes by Gemini' or name contains 'Gemini')"
    ].join(' and ');
    const p = new URLSearchParams({ q, orderBy: 'modifiedTime desc', pageSize: '200', fields: 'files(id,name,modifiedTime,webViewLink,owners(displayName))', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    const j = await gapi(token, `https://www.googleapis.com/drive/v3/files?${p}`);
    return json({ files: (j.files || []).map((f) => ({ id: f.id, name: f.name, modified: f.modifiedTime, link: f.webViewLink, kind: /gemini|anota/i.test(f.name) ? 'Anotações do Gemini' : 'Transcrição' })) });
  } catch (e) {
    console.log('[google]', new URL(request.url).pathname, e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}
