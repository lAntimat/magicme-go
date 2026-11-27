import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const GO = 'https://go.local.test';
const SITE = 'https://site.local.test';
const BASE = 'https://collector.local.test';
const AUTHORIZATION = 'Bearer local-test-token';
const NOW = '2026-11-27T21:15:00Z';
const MINUTE = Date.parse(NOW) / 60_000;
const DAY = 24 * 60;
const windowAt = (start, end, group = 0) => ({ start: MINUTE + start, end: MINUTE + end, group });

async function setup(t) {
  const worker = (await import('../collector/worker.mjs')).default;
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../collector/migrations/0001_minutes.sql', import.meta.url), 'utf8'));
  const env = {
    GO_ORIGIN: GO, SITE_ORIGIN: SITE, REPORT_TOKEN: 'local-test-token',
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        return {
          bind(...values) {
            return {
              execute: () => ({ results: statement.all(...values) }),
              run: async () => statement.run(...values),
            };
          },
        };
      },
      async batch(statements) {
        sqlite.exec('BEGIN');
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  return {
    sqlite,
    at(minuteOffset, secondOffset = 0) {
      t.mock.timers.setTime((MINUTE + minuteOffset) * 60_000 + secondOffset * 1000);
    },
    post(event, origin, { contentType = 'text/plain;charset=UTF-8', path = '/v1/events', ...rest } = {}) {
      return worker.fetch(new Request(BASE + path, {
        method: 'POST', headers: { 'Content-Type': contentType, ...(origin && { Origin: origin }) },
        body: event, ...rest,
      }), env);
    },
    report(body, { authorization = AUTHORIZATION, contentType = 'application/json', path = '/v1/report', method = 'POST', duplex } = {}) {
      return worker.fetch(new Request(BASE + path, {
        method,
        headers: { 'Content-Type': contentType, ...(authorization && { Authorization: authorization }) },
        body: method !== 'GET' ? (typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body)) : undefined,
        duplex,
      }), env);
    },
    prune(time) { return worker.scheduled({ scheduledTime: Date.parse(time) }, env); },
  };
}

test('disjoint UTC minute windows combine by group and exclude gaps, the end bound and future minutes', async (t) => {
  const api = await setup(t);
  const windows = [windowAt(-11, -10, 7), windowAt(-10, -9, 3), windowAt(-7, -6, 7), windowAt(0, 3, 8)];
  const empty = await api.report({ windows });
  assert.deepEqual(await empty.json(), { coverage: { go: null, site: null }, rows: [] });

  api.at(-10);
  const response = await api.post('go_open', GO);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), GO);
  api.at(-11, 59);
  assert.equal((await api.post('go_open', GO)).status, 204);
  api.at(-9);
  assert.equal((await api.post('go_click_copy', GO)).status, 204);
  api.at(-7);
  const statuses = await Promise.all([api.post('go_open', GO), api.post('go_open', GO), api.post('site_open', SITE)]);
  assert.ok(statuses.every((item) => item.status === 204));
  api.at(0);
  assert.equal((await api.post('go_click_open', GO)).status, 204);
  api.at(1);
  assert.equal((await api.post('go_click_open', GO)).status, 204);
  api.at(0);

  const report = await api.report({ windows });
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('Cache-Control'), 'no-store');
  assert.equal(report.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual(await report.json(), {
    coverage: { go: MINUTE - 11, site: MINUTE - 7 },
    rows: [
      { group: 3, event: 'go_open', count: 1 },
      { group: 7, event: 'go_open', count: 3 },
      { group: 7, event: 'site_open', count: 1 },
      { group: 8, event: 'go_click_open', count: 1 },
    ],
  });
});

test('events outside the protocol never establish coverage', async (t) => {
  const api = await setup(t);
  assert.equal((await api.post('site_open', GO)).status, 403);
  assert.equal((await api.post('go_open', SITE)).status, 403);
  assert.equal((await api.post('go_open', `${GO}.invalid`)).status, 403);
  assert.equal((await api.post('go_open')).status, 403);
  assert.equal((await api.post('go_open\n', GO)).status, 400);
  assert.equal((await api.post('\uFEFFgo_open', GO)).status, 400);
  assert.equal((await api.post('other', GO)).status, 400);
  assert.equal((await api.post('go_open', GO, { contentType: 'application/json' })).status, 415);
  assert.equal((await api.post('go_open', GO, { path: '/v1/events?user=1' })).status, 400);
  const largeBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('go_open'));
      controller.enqueue(new Uint8Array(32));
    },
  });
  assert.equal((await api.post(largeBody, GO, { duplex: 'half' })).status, 413);
  const report = await api.report({ windows: [windowAt(-DAY, DAY)] });
  assert.deepEqual(await report.json(), { coverage: { go: null, site: null }, rows: [] });
});

test('reports authorize only JSON POST requests', async (t) => {
  const api = await setup(t);
  const query = { windows: [windowAt(-91 * DAY, 26 * 60, 89)] };
  assert.equal((await api.report(query)).status, 200);
  assert.equal((await api.report(query, { authorization: null })).status, 401);
  assert.equal((await api.report(query, { authorization: 'Bearer other-test-token' })).status, 401);
  assert.equal((await api.report(query, { method: 'GET' })).status, 405);
  assert.equal((await api.report(query, { path: '/v1/report?other=1' })).status, 400);
  assert.equal((await api.report(query, { contentType: 'text/plain' })).status, 415);
});

test('report windows have exact integer fields, positive duration, sorted non-overlapping bounds and a limited span', async (t) => {
  const api = await setup(t);
  const invalid = [
    '', '{', 'null', '[]', { windows: null }, { windows: [], extra: true },
    { windows: [null] }, { windows: [{ ...windowAt(0, 1), extra: true }] },
    { windows: [windowAt(-91 * DAY - 1, -1)] }, { windows: [windowAt(0, 26 * 60 + 1)] },
    { windows: [windowAt(0, 0)] }, { windows: [windowAt(0, -1)] },
    { windows: [windowAt(0, 2), windowAt(1, 3)] }, { windows: [windowAt(2, 3), windowAt(0, 1)] },
    { windows: [windowAt(-0.5, 1)] }, { windows: [windowAt(0, 0.5)] },
    { windows: [windowAt(0, 1, 0.5)] }, { windows: [windowAt(0, 1, -1)] },
    { windows: [windowAt(0, 1, 90)] }, { windows: [windowAt(0, 1, '0')] },
    { windows: [{ ...windowAt(0, 1), end: 'not-an-integer' }] },
    { windows: [{ ...windowAt(0, 1), end: Number.MAX_SAFE_INTEGER + 1 }] },
  ];
  for (const malformed of invalid) {
    assert.equal((await api.report(malformed)).status, 400, JSON.stringify(malformed));
  }
});

test('reports accept 2300 windows in one query and bound the body while streaming', async (t) => {
  const api = await setup(t);
  const windows = Array.from({ length: 2300 }, (_, index) => windowAt(index - 2300, index - 2299, index % 90));
  assert.equal((await api.report({ windows })).status, 200);
  assert.equal((await api.report({ windows: [...windows, windowAt(0, 1)] })).status, 400);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"windows":[]}'));
      controller.enqueue(new Uint8Array(155 * 1024));
    },
  });
  assert.equal((await api.report(stream, { duplex: 'half' })).status, 413);
});

test('daily pruning expires aggregates older than 92 days and keeps the first coverage minute', async (t) => {
  const api = await setup(t);
  api.at(-92 * DAY - 1);
  await api.post('go_open', GO);
  api.at(-92 * DAY);
  await api.post('go_open', GO);
  api.at(-91 * DAY);
  await api.post('go_open', GO);
  api.at(0);
  await api.prune(NOW);
  assert.equal(api.sqlite.prepare('SELECT count(*) AS rows FROM minute_events').get().rows, 2);
  const report = await api.report({ windows: [windowAt(-91 * DAY, 1)] });
  assert.deepEqual(await report.json(), {
    coverage: { go: MINUTE - 92 * DAY - 1, site: null },
    rows: [{ group: 0, event: 'go_open', count: 1 }],
  });
});
