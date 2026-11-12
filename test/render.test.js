import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPage, loadPages } from '../src/pages.js';
import { createRenderer, playwrightCli, serve } from '../src/render.js';

const dirSite = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');
const { renderer, reason } = await createRenderer({ viewports: [{ width: 800, height: 600 }] });

describe('createRenderer browsers', () => {
  test('Falls back to other browsers where one doesn’t start, naming the one used', { skip: renderer ? false : `No browser: ${reason}` }, async () => {
    const found = await createRenderer({ browsers: [{ name: 'Nothing', channel: 'nonexistent' }, { name: 'Edge', channel: 'msedge' }, { name: 'Chromium' }, { name: 'Chrome', channel: 'chrome' }] });
    assert.match(found.renderer?.browser ?? '', /^(Edge|Chromium|Chrome) \d+/);
    await found.renderer?.close();
  });

  test('Reports where no browser starts', async () => {
    const found = await createRenderer({ browsers: [{ name: 'Nothing', channel: 'nonexistent' }] });
    assert.strictEqual(found.renderer, null);
    assert.strictEqual(found.missing, true);
    assert.match(found.reason, /No browser/);
  });

  test('Finds Playwright’s installer', () => {
    assert.ok(fs.existsSync(/** @type {string} */ (playwrightCli())));
  });
});

describe('createRenderer', { skip: renderer ? false : `No browser: ${reason}` }, () => {
  /** @type {import('../src/render.js').Renderer} */
  let r;
  before(() => { r = /** @type {import('../src/render.js').Renderer} */ (renderer); });
  after(() => r.close());

  test('Finds markup that renders the same equal', async () => {
    const page = createPage({ id: 'a.html', html: '<!doctype html><p>a   b</p>' });
    const verdict = await r.compare(page, '<!doctype html><p>a b');
    assert.deepStrictEqual(verdict.reasons, []);
    assert.strictEqual(verdict.equal, true);
  });

  test('Finds whitespace that linked CSS keeps', async () => {
    const [poem] = await loadPages([path.join(dirSite, 'poem.html')]);
    assert.ok(poem);
    const collapsed = poem.html.replace(/<\/span>\s+<span>/, '</span> <span>');
    const verdict = await r.compare(poem, collapsed);
    assert.strictEqual(verdict.equal, false);
    assert.match(verdict.reasons.join(), /800×600/);
  });

  test('Reports script errors the original doesn’t have', async () => {
    const page = createPage({ id: 'b.html', html: '<!doctype html><p>a</p><script>var a = 1;</script>' });
    const verdict = await r.compare(page, '<!doctype html><p>a</p><script>var a = ;</script>');
    assert.strictEqual(verdict.equal, false);
    assert.match(verdict.reasons.join(), /script error/i);
  });

  test('Doesn’t compare text that differs between loads of the original', async () => {
    const page = createPage({ id: 'd.html', html: '<!doctype html><p style="color: transparent">x</p><script>document.querySelector("p").textContent = Math.random()</script>' });
    const verdict = await r.compare(page, page.html);
    assert.strictEqual(verdict.equal, true);
    assert.match(verdict.notes.join(), /Text differs between loads/);
  });

  test('Ignores script errors the original has, too', async () => {
    const page = createPage({ id: 'c.html', html: '<!doctype html><p>a</p><script>nope()</script>' });
    const verdict = await r.compare(page, '<!doctype html><p>a</p><script>nope()</script>');
    assert.strictEqual(verdict.equal, true);
  });
});
describe('serve', () => {
  test('Serves files within the root, answering malformed paths and paths outside the root with client errors', async () => {
    const server = await serve(dirSite);
    /** @type {number[]} */
    const statuses = [];
    try {
      for (const pathname of ['/css/site.css', '/%E0%A4%A', '/..%2F..%2Fpages.test.js', '/missing.css']) {
        statuses.push((await fetch(`${server.origin}${pathname}`)).status);
      }
    } finally {
      await server.close();
    }
    assert.deepStrictEqual(statuses, [200, 400, 404, 404]);
  });
});
