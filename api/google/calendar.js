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
