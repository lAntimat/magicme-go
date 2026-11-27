import { createHash, timingSafeEqual } from 'node:crypto';

const events = new Map([
  ['go_open', 'go'],
  ['go_click_open', 'go'],
  ['go_click_copy', 'go'],
  ['site_open', 'site'],
]);
const maxEventBytes = Math.max(...Array.from(events.keys(), (event) => event.length));
const maxReportBytes = 155 * 1024;
const maxReportWindows = 2300;
const minutesPerDay = 24 * 60;

function epochMinute(time) {
  return Math.floor(time / 60_000);
}

function mediaType(request) {
  return request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
}

function emptyResponse(status, headers = {}) {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

async function readBody(request, maxBytes) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const buffer = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buffer.subarray(0, size));
      if (size + value.length > maxBytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      buffer.set(value, size);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

async function recordEvent(request, url, env) {
  if (request.method !== 'POST') return emptyResponse(405, { Allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (!origin || (origin !== env.GO_ORIGIN && origin !== env.SITE_ORIGIN)) return emptyResponse(403);
  const headers = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (url.search) return emptyResponse(400, headers);
  if (mediaType(request) !== 'text/plain') return emptyResponse(415, headers);
  const event = await readBody(request, maxEventBytes);
  if (event === null) return emptyResponse(413, headers);
  const source = events.get(event);
  if (!source) return emptyResponse(400, headers);
  if (origin !== (source === 'go' ? env.GO_ORIGIN : env.SITE_ORIGIN)) return emptyResponse(403, headers);

  const minute = epochMinute(Date.now());
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO minute_events (minute, event, count) VALUES (?, ?, 1)
        ON CONFLICT (minute, event) DO UPDATE SET count = count + 1
    `).bind(minute, event),
    env.DB.prepare(`
      INSERT INTO coverage (source, minute) VALUES (?, ?)
        ON CONFLICT (source) DO UPDATE SET minute = excluded.minute
        WHERE excluded.minute < coverage.minute
    `).bind(source, minute),
  ]);
  return emptyResponse(204, headers);
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function parseWindows(body, now) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(payload?.windows) || Object.keys(payload).length !== 1 || payload.windows.length > maxReportWindows) {
    return null;
  }

  let previousEnd = now - 91 * minutesPerDay;
  const latestEnd = now + 26 * 60;
  const windows = [];
  for (const window of payload.windows) {
    if (!window || Object.keys(window).length !== 3) return null;
    const { start, end, group } = window;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previousEnd || end <= start
      || end > latestEnd || !Number.isInteger(group) || group < 0 || group > 89) return null;

    if (start <= now) windows.push({ start, end: Math.min(end, now + 1), group });
    previousEnd = end;
  }
  return windows;
}

async function report(request, url, env) {
  if (request.method !== 'POST') return emptyResponse(405, { Allow: 'POST' });
  if (!env.REPORT_TOKEN || !timingSafeEqual(
    digest(request.headers.get('Authorization') ?? ''), digest(`Bearer ${env.REPORT_TOKEN}`),
  )) return emptyResponse(401, { 'WWW-Authenticate': 'Bearer' });
  if (url.search) return emptyResponse(400);
  if (mediaType(request) !== 'application/json') return emptyResponse(415);

  const body = await readBody(request, maxReportBytes);
  if (body === null) return emptyResponse(413);
  const windows = parseWindows(body, epochMinute(Date.now()));
  if (!windows) return emptyResponse(400);

  const [coverageRows, reportRows] = await env.DB.batch([
    env.DB.prepare('SELECT source, minute FROM coverage').bind(),
    env.DB.prepare(`
      SELECT json_extract(windows.value, '$.group') AS "group", events.event, SUM(events.count) AS count
        FROM json_each(?) AS windows
        CROSS JOIN minute_events AS events
          ON events.minute >= json_extract(windows.value, '$.start')
          AND events.minute < json_extract(windows.value, '$.end')
        GROUP BY "group", events.event ORDER BY "group", events.event
    `).bind(JSON.stringify(windows)),
  ]);
  const coverage = { go: null, site: null };
  for (const { source, minute } of coverageRows.results) coverage[source] = minute;
  return Response.json({ coverage, rows: reportRows.results }, { headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/v1/events') return await recordEvent(request, url, env);
      if (url.pathname === '/v1/report') return await report(request, url, env);
      return emptyResponse(404);
    } catch {
      return emptyResponse(503);
    }
  },
  async scheduled(controller, env) {
    const cutoff = epochMinute(controller.scheduledTime) - 92 * minutesPerDay;
    await env.DB.prepare('DELETE FROM minute_events WHERE minute < ?').bind(cutoff).run();
  },
};
