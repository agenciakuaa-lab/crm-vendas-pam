// GET /api/google/calendar?from=2026-11-01&to=2026-11-30 → eventos de todas as agendas visíveis da conta, no fuso de São Paulo
import { json, userFromRequest } from '../_lib.js';
import { googleToken, gapi } from '../_google.js';

const TZ = 'America/Sao_Paulo';
const clean = (h) => String(h || '')
  .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, (m, url, txt) => (txt && !url.includes(txt) ? `${txt} (${url})` : url))
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<li>/gi, '• ')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\n{3,}/g, '\n\n').trim();

export async function GET(request) {
  try {
    const user = await userFromRequest(request);
    if (!user) return json({ error: 'Faça login no CRM' }, 401);
    const token = await googleToken(user.id);
    const q = new URL(request.url).searchParams;
    const from = q.get('from') || new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
    const to = q.get('to') || from;
    // agendas marcadas como visíveis na conta (principal + compartilhadas)
    const cl = await gapi(token, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=50').catch(() => ({ items: [] }));
    const cals = (cl.items || []).filter((c) => c.primary || c.selected).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, color: c.backgroundColor, primary: !!c.primary }));
    if (!cals.length) cals.push({ id: 'primary', name: 'Principal', primary: true });
    const params = (pageToken) => new URLSearchParams({
      timeMin: new Date(`${from}T00:00:00-03:00`).toISOString(),
      timeMax: new Date(`${to}T23:59:59-03:00`).toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeZone: TZ, ...(pageToken ? { pageToken } : {})
    });
    const events = [];
    for (const c of cals.slice(0, 10)) {
      let pageToken = '';
      do {
        const j = await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${params(pageToken)}`).catch(() => ({}));
        for (const e of j.items || []) {
          if (e.status === 'cancelled') continue;
          const self = (e.attendees || []).find((a) => a.self);
          if (self && self.responseStatus === 'declined') continue;
          const entry = (e.conferenceData?.entryPoints || []);
          events.push({
            id: `${c.primary ? '' : c.id + '|'}${e.id}`, calendar: c.name, calendarColor: c.color,
            title: e.summary || '(sem título)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
            allDay: !e.start?.dateTime, timeZone: e.start?.timeZone || TZ,
            meet: e.hangoutLink || entry.find((x) => x.entryPointType === 'video')?.uri || null,
            phone: entry.find((x) => x.entryPointType === 'phone')?.label || null,
            location: e.location || null, htmlLink: e.htmlLink || null,
            organizer: e.organizer ? (e.organizer.displayName || e.organizer.email) : null,
            myStatus: self?.responseStatus || null,
            attendees: (e.attendees || []).filter((a) => !a.self && !a.resource).map((a) => ({ email: a.email, name: a.displayName || a.email, status: a.responseStatus, organizer: !!a.organizer })),
            attachments: (e.attachments || []).map((a) => ({ title: a.title, url: a.fileUrl })),
            description: clean(e.description).slice(0, 4000)
          });
        }
        pageToken = j.nextPageToken || '';
      } while (pageToken && events.length < 1500);
    }
    events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return json({ events, calendars: cals.map((c) => c.name) });
  } catch (e) {
    console.log('[google]', new URL(request.url).pathname, e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}

// id do CRM → agenda + id do evento ("agenda|evento" quando não é a principal)
const splitId = (id) => { const i = String(id || '').lastIndexOf('|'); return i > 0 ? [id.slice(0, i), id.slice(i + 1)] : ['primary', id]; };
const evUrl = (cal, ev, q = '') => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events${ev ? '/' + encodeURIComponent(ev) : ''}${q}`;

function toGoogle(b) {
  const out = {};
  if (b.title !== undefined) out.summary = b.title;
  if (b.location !== undefined) out.location = b.location;
  if (b.description !== undefined) out.description = b.description;
  if (b.start) {
    if (b.allDay) {
      const end = b.end && b.end > b.start ? b.end : new Date(new Date(b.start + 'T12:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
      out.start = { date: b.start.slice(0, 10) }; out.end = { date: end.slice(0, 10) };
    } else {
      out.start = { dateTime: b.start.length === 16 ? b.start + ':00' : b.start, timeZone: TZ };
      out.end = { dateTime: (b.end || b.start).length === 16 ? (b.end || b.start) + ':00' : (b.end || b.start), timeZone: TZ };
    }
  }
  if (Array.isArray(b.attendees)) out.attendees = b.attendees.filter((e) => /\S+@\S+/.test(e)).map((email) => ({ email: email.trim() }));
  if (b.addMeet) out.conferenceData = { createRequest: { requestId: 'crm-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  return out;
}

async function auth(request) {
  const user = await userFromRequest(request);
  if (!user) { const e = new Error('Faça login no CRM'); e.status = 401; throw e; }
  return googleToken(user.id);
}
const fail = (request, e) => { console.log('[google]', new URL(request.url).pathname, e.status || 500, e.message); return json({ error: /insufficient|scope/i.test(e.message) ? 'Reconecte a conta Google em Integrações para liberar a edição da agenda.' : e.message }, e.status || 500); };

// POST → cria compromisso
export async function POST(request) {
  try {
    const token = await auth(request); const b = await request.json();
    if (!b.title || !b.start) return json({ error: 'Informe título e início' }, 400);
    const notify = b.notify ? 'all' : 'none';
    const j = await gapi(token, evUrl('primary', '', `?sendUpdates=${notify}&conferenceDataVersion=1`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toGoogle(b)) });
    return json({ ok: true, id: j.id });
  } catch (e) { return fail(request, e); }
}

// PATCH {id, ...campos} → edita
export async function PATCH(request) {
  try {
    const token = await auth(request); const b = await request.json();
    const [cal, ev] = splitId(b.id); if (!ev) return json({ error: 'Compromisso sem id' }, 400);
    const notify = b.notify ? 'all' : 'none';
    await gapi(token, evUrl(cal, ev, `?sendUpdates=${notify}&conferenceDataVersion=1`), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toGoogle(b)) });
    return json({ ok: true });
  } catch (e) { return fail(request, e); }
}

// DELETE ?id=...&notify=1 → exclui
export async function DELETE(request) {
  try {
    const token = await auth(request); const q = new URL(request.url).searchParams;
    const [cal, ev] = splitId(q.get('id')); if (!ev) return json({ error: 'Compromisso sem id' }, 400);
    const r = await fetch(evUrl(cal, ev, `?sendUpdates=${q.get('notify') === '1' ? 'all' : 'none'}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok && r.status !== 410) { const j = await r.json().catch(() => ({})); const e = new Error(j.error?.message || `Google ${r.status}`); e.status = r.status; throw e; }
    return json({ ok: true });
  } catch (e) { return fail(request, e); }
}
