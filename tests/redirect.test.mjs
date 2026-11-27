import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const configuredEndpoint = html.match(/<meta name="go-statistics-endpoint" content="([^"]*)">/)?.[1];
const siteEndpoint = 'https://magicmebook.ru/site-api/go-activity';
const target = 'https://magicmebook.ru/?utm_source=instagram&utm_medium=social&utm_campaign=go';

function load({ userAgent = '', endpoint = configuredEndpoint, offline = false, clipboard = false } = {}) {
  const timeline = [];
  const probes = [];
  const copied = {};
  function element() {
    return {
      hidden: true, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      click() { this.listeners.click?.(); },
      parentNode: { querySelector: () => copied },
    };
  }
  const ids = Object.fromEntries([...html.matchAll(/\bid="([\w-]+)"/g)].map((match) => [match[1], element()]));
  const copy = element();
  const requests = [];
  runInNewContext(script, {
    URL,
    document: {
      getElementById: (id) => ids[id],
      querySelector: (selector) => selector === 'meta[name="go-statistics-endpoint"]' ? { content: endpoint } : null,
      querySelectorAll: (selector) => selector === '[data-copy]' ? [copy] : [],
    },
    navigator: {
      userAgent,
      clipboard: clipboard ? { writeText: (value) => { timeline.push(value); return Promise.resolve(); } } : undefined,
    },
    window: {
      location: {
        replace: (value) => timeline.push(value),
        set href(value) { timeline.push(value); },
      },
    },
    fetch(url, options) {
      timeline.push(options.body);
      requests.push([String(url), { ...options }]);
      return offline ? Promise.reject(new Error('offline')) : Promise.resolve(new Response(null, { status: 204 }));
    },
    Image: class { constructor() { probes.push(this); } },
    setTimeout() {},
  });
  return { timeline, probes, ids, copy, copied, requests };
}

test('Android sends a page opening before automatic intent without counting an automatic click', () => {
  const { timeline, requests, ids } = load({ userAgent: 'Instagram Android' });
  assert.deepEqual(timeline, ['go_open', ids['android-open'].href]);
  assert.equal(timeline[1], `intent://magicmebook.ru/?utm_source=instagram&utm_medium=social&utm_campaign=go#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(target)};end`);
  assert.deepEqual(requests[0], [siteEndpoint, {
    method: 'POST', body: 'go_open', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
    keepalive: true,
  }]);
  ids['android-open'].click();
  assert.equal(timeline[2], 'go_click_open');
});

test('the browser redirect preserves the target and tracks only explicit opening clicks', () => {
  const { timeline, ids, probes } = load();
  assert.equal(ids['site-link'].href, target);
  probes[0].onload();
  assert.deepEqual(timeline, ['go_open', target]);
  ids['site-link'].click();
  assert.deepEqual(timeline, ['go_open', target, 'go_click_open']);
});

test('copy clicks are counted whether the clipboard works or offers the manual fallback', async () => {
  for (const clipboard of [true, false]) {
    const { timeline, copy, copied, ids } = load({ userAgent: 'Instagram iPhone', offline: true, clipboard });
    assert.equal(ids.inapp.hidden, false);
    copy.click();
    await Promise.resolve();
    assert.deepEqual(timeline, clipboard ? ['go_open', 'go_click_copy', target] : ['go_open', 'go_click_copy']);
    assert.equal(copied.textContent, clipboard ? 'Ссылка скопирована. Вставьте её в Safari или Chrome.' : `Скопируйте вручную: ${target}`);
  }
});

test('a temporary HTTPS endpoint keeps its configured path', () => {
  const endpoint = 'https://stats.example.test:8443/synthetic/go-activity';
  const { requests } = load({ endpoint });
  assert.equal(requests[0]?.[0], endpoint);
});

test('empty or unsuitable endpoint configuration leaves the normal redirect working', () => {
  for (const endpoint of ['', 'http://localhost:8000/go-activity', '/go-activity', 'https://test.example/go-activity?foo=bar', 'https://test.example/go-activity#foo', 'https://user:test@test.example/go-activity']) {
    const { timeline, probes } = load({ endpoint });
    probes[0].onerror();
    assert.deepEqual(timeline, [target], endpoint);
  }
});
