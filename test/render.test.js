import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPage, loadPages } from '../src/pages.js';
import { createRenderer, playwrightCli } from '../src/render.js';

const dirSite = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');
const { renderer, reason } = await createRenderer({ viewports: [{ width: 800, height: 600 }] });

describe('createRenderer browsers', () => {
  test('Falls back to other browsers where one doesn’t start, naming the one used', { skip: renderer ? false : `No browser: ${reason}` }, async () => {
    const found = await createRenderer({ browsers: [{ name: 'Nothing', channel: 'nonexistent' }, { name: 'Chromium' }, { name: 'Chrome', channel: 'chrome' }] });
    assert.match(found.renderer?.browser ?? '', /^(Chromium|Chrome) \d+/);
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

  test('Ignores script errors the original has, too', async () => {
    const page = createPage({ id: 'c.html', html: '<!doctype html><p>a</p><script>nope()</script>' });
    const verdict = await r.compare(page, '<!doctype html><p>a</p><script>nope()</script>');
    assert.strictEqual(verdict.equal, true);
  });
});