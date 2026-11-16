// GET /api/google/calendar?from=2026-11-01&to=2026-11-30 → eventos da agenda principal
import { json, userFromRequest } from '../_lib.js';
import { googleToken, gapi } from '../_google.js';

export async function GET(request) {
  try {
    const user = await userFromRequest(request);
    if (!user) return json({ error: 'Faça login no CRM' }, 401);
    const token = await googleToken(user.id);
    const q = new URL(request.url).searchParams;
    const from = q.get('from') || new Date().toISOString().slice(0, 10);
    const to = q.get('to') || from;
    const params = new URLSearchParams({
      timeMin: new Date(`${from}T00:00:00-03:00`).toISOString(),
      timeMax: new Date(`${to}T23:59:59-03:00`).toISOString(),
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeZone: 'America/Sao_Paulo'
    });
    const j = await gapi(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
    const events = (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
      id: e.id, title: e.summary || '(sem título)', start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
      allDay: !e.start?.dateTime, meet: e.hangoutLink || null, location: e.location || null,
      attendees: (e.attendees || []).filter((a) => !a.self).map((a) => ({ email: a.email, name: a.displayName || a.email, status: a.responseStatus })),
      description: (e.description || '').replace(/<[^>]+>/g, ' ').slice(0, 600)
    }));
    return json({ events });
  } catch (e) {
    console.log('[google]', new URL(request.url).pathname, e.status || 500, e.message);
    return json({ error: e.message }, e.status || 500);
  }
}
