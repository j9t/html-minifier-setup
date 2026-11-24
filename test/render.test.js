import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPage, loadPages } from '../src/pages.js';
import { combineOriginals, createGuard, createLimit, createRenderer, playwrightCli, regionsMoved, serve, shiftOf } from '../src/render.js';

const dirSite = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');
const { renderer, reason } = await createRenderer({ viewports: [{ width: 800, height: 600 }] });
// At the top level, as hooks of suites whose tests are filtered out don’t run
after(() => renderer?.close());

/** The IDs of this process’s child processes (none where `pgrep` finds none) */
const childPids = () => {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').map(Number);
  } catch {
    return [];
  }
};

/**
 * Ends the given processes, where they haven’t ended already
 * @param {number[]} pids
 */
const killAll = (pids) => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already ended
    }
  }
};

describe('`createRenderer` browsers', () => {
  test('Falls back to other browsers where one doesn’t start, naming the one used', { skip: renderer ? false : `No browser: ${reason}` }, async () => {
    // In default order, as other browsers may be installed but take long to fail (e.g., Edge in CI)
    const found = await createRenderer({ browsers: [{ name: 'Nothing', channel: 'nonexistent' }, { name: 'Chromium' }, { name: 'Chrome', channel: 'chrome' }, { name: 'Edge', channel: 'msedge' }] });
    assert.strictEqual(found.renderer?.browser, renderer?.browser);
    await found.renderer?.close();
  });

  test('Reports where no browser starts', async () => {
    const found = await createRenderer({ browsers: [{ name: 'Nothing', channel: 'nonexistent' }] });
    assert.strictEqual(found.renderer, null);
    assert.strictEqual(found.missing, true);
    assert.match(found.reason, /No browser/);
  });

  test('Fails on concurrency that would render no page', async () => {
    for (const concurrency of [0, 1.5, Number.NaN]) {
      await assert.rejects(createRenderer({ concurrency }), /concurrency/i);
    }
  });

  test('Fails on shifts that aren’t whole pixels', async () => {
    for (const allowShift of [-1, 1.5, Number.NaN]) {
      await assert.rejects(createRenderer({ allowShift }), /shift/i);
    }
  });

  test('Finds Playwright’s installer', () => {
    assert.ok(fs.existsSync(/** @type {string} */ (playwrightCli())));
  });
});

describe('`createRenderer`', { skip: renderer ? false : `No browser: ${reason}` }, () => {
  /** @type {import('../src/render.js').Renderer} */
  let r;
  before(() => { r = /** @type {import('../src/render.js').Renderer} */ (renderer); });

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

  test('Finds the comparison inconclusive where the original’s looks and text both differ between loads', async () => {
    const page = createPage({ id: 'e.html', html: '<!doctype html><p>x</p><script>document.querySelector("p").textContent = Math.random(); document.body.style.background = `hsl(${Math.random() * 360} 50% 50%)`</script>' });
    const verdict = await r.compare(page, '<!doctype html><h1>Something else entirely</h1>');
    assert.strictEqual(verdict.equal, false);
    assert.strictEqual(verdict.inconclusive, true);
    assert.deepStrictEqual(verdict.reasons, []);
  });

  test('Renders the given markup for page URLs with fragments', async () => {
    const server = await serve(dirSite);
    try {
      const page = createPage({ id: 'poem.html', html: '<!doctype html><p>Original</p>', url: `${server.origin}/poem.html#verse` });
      const verdict = await r.compare(page, '<!doctype html><p>Something else</p>');
      assert.strictEqual(verdict.equal, false);
    } finally {
      await server.close();
    }
  });

  test('Rejects captures of pages that stop responding after loading, instead of waiting for them, and renders other pages', async () => {
    // Closing the stopped page can take over a second (as on Windows in CI),
    // which would count as the browser stopping
    const found = await createRenderer({ viewports: [{ width: 800, height: 600 }], timeout: 3000 });
    const rendererHung = /** @type {import('../src/render.js').Renderer} */ (found.renderer);
    try {
      const html = '<!doctype html><p>a</p><script>addEventListener("load", () => setTimeout(() => { for (;;); }, 0))</script>';
      await assert.rejects(rendererHung.compare(createPage({ id: 'a.html', html }), html), /Page stopped responding/);
      const verdict = await rendererHung.compare(createPage({ id: 'b.html', html: '<p>b' }), '<p>b');
      assert.strictEqual(verdict.equal, true);
    } finally {
      await found.renderer?.close();
    }
  });

  test('Rejects captures where the browser stops responding, at once after the first, and ends the browser on closing', { skip: process.platform === 'win32' ? 'No SIGSTOP on Windows' : false }, async () => {
    const pidsBefore = childPids();
    const found = await createRenderer({ viewports: [{ width: 800, height: 600 }], timeout: 1000 });
    const rendererPaused = /** @type {import('../src/render.js').Renderer} */ (found.renderer);
    const pids = childPids().filter((pid) => !pidsBefore.includes(pid));
    let closed = false;
    try {
      assert.ok(pids.length, 'Browser process found');
      // As the browser stalls on macOS where RunningBoard doesn’t answer
      for (const pid of pids) process.kill(pid, 'SIGSTOP');
      await assert.rejects(rendererPaused.compare(createPage({ id: 'a.html', html: '<p>a' }), '<p>a'), /Browser stopped responding/);
      const start = Date.now();
      await assert.rejects(rendererPaused.compare(createPage({ id: 'b.html', html: '<p>b' }), '<p>b'), /Browser stopped responding/);
      assert.ok(Date.now() - start < 500, 'Rejects at once');
      await rendererPaused.close();
      closed = true;
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      if (!closed) await rendererPaused.close();
      killAll(pids);
    }
  });

  test('Ends browsers that don’t close on their own without waiting as long as for pages', { skip: process.platform === 'win32' ? 'No SIGSTOP on Windows' : false }, async () => {
    const pidsBefore = childPids();
    const found = await createRenderer({ viewports: [{ width: 800, height: 600 }], timeout: 30000 });
    const pids = childPids().filter((pid) => !pidsBefore.includes(pid));
    try {
      assert.ok(pids.length, 'Browser process found');
      // As Chrome and Edge sometimes don’t end when asked to close
      for (const pid of pids) process.kill(pid, 'SIGSTOP');
      const start = Date.now();
      await found.renderer?.close();
      assert.ok(Date.now() - start < 10000, `Closed after ${Date.now() - start} ms`);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      killAll(pids);
    }
  });

  test('Rejects captures where the browser stops responding while loading a page, with the error the capture had', { skip: process.platform === 'win32' ? 'No SIGSTOP on Windows' : false }, async () => {
    const pidsBefore = childPids();
    const found = await createRenderer({ viewports: [{ width: 800, height: 600 }], timeout: 1000 });
    const rendererPaused = /** @type {import('../src/render.js').Renderer} */ (found.renderer);
    const pids = childPids().filter((pid) => !pidsBefore.includes(pid));
    let paused = false;
    let requests = 0;
    // Pauses the browser as the last of the three captures (the original twice, and the minified
    // page) asks for the style sheet, which then never comes, for all to be loading
    const server = http.createServer(() => {
      if (++requests < 3) return;
      for (const pid of pids) process.kill(pid, 'SIGSTOP');
      paused = true;
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    try {
      assert.ok(pids.length, 'Browser process found');
      const html = '<!doctype html><link rel=stylesheet href=stall.css><p>a</p>';
      await assert.rejects(rendererPaused.compare(createPage({ id: 'a.html', html, url: `http://127.0.0.1:${port}/a.html` }), html), /page\.goto: Timeout 1000ms exceeded/);
      assert.ok(paused, 'Browser paused while loading');
    } finally {
      server.closeAllConnections();
      server.close();
      await rendererPaused.close();
      killAll(pids);
    }
  });

  test('Names files it didn’t get, as symbolic links lead outside the site', async (t) => {
    const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-blocked-')));
    try {
      const dirRoot = path.join(dir, 'site');
      await fs.promises.mkdir(path.join(dir, 'shared'), { recursive: true });
      await fs.promises.mkdir(dirRoot);
      await fs.promises.writeFile(path.join(dir, 'shared', 'poem.css'), '.poem { white-space: pre; }');
      await fs.promises.writeFile(path.join(dirRoot, 'index.html'), '<!doctype html><link rel=stylesheet href=shared/poem.css><p class=poem>a   b</p>');
      try {
        await fs.promises.symlink(path.join(dir, 'shared'), path.join(dirRoot, 'shared'), 'dir');
      } catch (err) {
        t.skip(`No symbolic links: ${err instanceof Error ? err.message : err}`);
        return;
      }
      const [page] = await loadPages([dirRoot]);
      const verdict = await r.compare(/** @type {import('../src/pages.js').Page} */ (page), '<!doctype html><link rel=stylesheet href=shared/poem.css><p class=poem>a b</p>');
      assert.deepStrictEqual(verdict.blocked, ['shared/poem.css']);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test('Ignores script errors that come and go between loads', async () => {
    // Only the minified page loads the script, which fails on its first load alone
    let loads = 0;
    const server = http.createServer((request, response) => {
      const isScript = request.url === '/flaky.js';
      response.writeHead(200, { 'content-type': isScript ? 'text/javascript' : 'text/html' });
      response.end(isScript && ++loads === 1 ? 'throw new Error("Now and then")' : '');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    try {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const page = createPage({ id: 'f.html', html: '<!doctype html><p>a</p>', url: `http://127.0.0.1:${port}/f.html` });
      const verdict = await r.compare(page, '<!doctype html><p>a<script src="flaky.js"></script>');
      assert.deepStrictEqual(verdict.reasons, []);
      assert.strictEqual(loads, 2);
    } finally {
      server.close();
    }
  });

  test('Ignores script errors the original has, too', async () => {
    const page = createPage({ id: 'c.html', html: '<!doctype html><p>a</p><script>nope()</script>' });
    const verdict = await r.compare(page, '<!doctype html><p>a</p><script>nope()</script>');
    assert.strictEqual(verdict.equal, true);
  });

  test('Finds markup that only changes anti-aliasing equal', async () => {
    // Comments split text, which then renders at slightly different sub-pixel offsets
    const style = '<style>body { font: 15px/1.5 sans-serif; text-align: center }</style>';
    const page = createPage({ id: 'g.html', html: `<!doctype html>${style}<p>Filter entries on this page:<!-- a --> <!-- b --><span>Tech</span> more` });
    const verdict = await r.compare(page, `<!doctype html>${style}<p>Filter entries on this page: <span>Tech</span> more`);
    assert.deepStrictEqual(verdict.reasons, []);
  });

  test('Finds whitespace that only shows in text, not on screen, equal', async () => {
    const style = '<style>ul { display: flex; gap: 1em; list-style: none }</style>';
    const page = createPage({ id: 'h.html', html: `<!doctype html>${style}<ul><li>One</li> <li>Two</li></ul>` });
    const verdict = await r.compare(page, `<!doctype html>${style}<ul><li>One</li><li>Two</li></ul>`);
    assert.deepStrictEqual(verdict.reasons, []);
  });

  test('Reports how far elements move where that is all that differs', async () => {
    const page = createPage({ id: 'i.html', html: '<!doctype html><main><p style="margin-left: 0">One</p></main>' });
    const verdict = await r.compare(page, '<!doctype html><main><p style="margin-left: 8px">One</p></main>');
    assert.deepStrictEqual(verdict.reasons, ['Moves elements by up to 8 px at 800×600 (e.g., main > p)']);
    assert.strictEqual(verdict.shift, 8);
  });

  test('Reports text that runs together, beyond elements moving', async () => {
    const style = '<style>ul { margin: 0; padding: 0; text-align: center } li { display: inline; margin-right: 1em }</style>';
    const page = createPage({ id: 'l.html', html: `<!doctype html>${style}<ul><li><a href=#>One</a>\n<li><a href=#>Two</a>\n</ul>` });
    const verdict = await r.compare(page, `<!doctype html>${style}<ul><li><a href=#>One</a><li><a href=#>Two</a></ul>`);
    assert.match(verdict.reasons.join('\n'), /^Moves elements by up to \d+ px at 800×600 \(e\.g\., ul > li\)\nText differs at 800×600: “One Two” became “OneTwo”$/);
    assert.strictEqual(verdict.shift, null);
  });

  test('Finds what looks different beyond elements moving by less than a pixel different', async () => {
    const page = createPage({ id: 'n.html', html: '<!doctype html><p style="margin-left: 0">One</p><p style="color: #000">Two</p>' });
    const verdict = await r.compare(page, '<!doctype html><p style="margin-left: 0.4px">One</p><p style="color: #222">Two</p>');
    assert.deepStrictEqual(verdict.reasons, ['Looks different at 800×600']);
  });

  test('Finds what looks different without moving different', async () => {
    const page = createPage({ id: 'j.html', html: '<!doctype html><p style="color: #000">Some text</p>' });
    const verdict = await r.compare(page, '<!doctype html><p style="color: #222">Some text</p>');
    assert.deepStrictEqual(verdict.reasons, ['Looks different at 800×600']);
    assert.strictEqual(verdict.shift, null);
  });

  test('Loads lazy images before comparing, as full-page screenshots show them', async () => {
    const server = http.createServer((_request, response) => {
      // Late, as images over a network can be
      setTimeout(() => response.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="red"/></svg>'), 300);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    try {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const page = createPage({ id: 'm.html', html: `<!doctype html><div style="height: 3000px"></div><img src=http://127.0.0.1:${port}/a.svg alt="" loading=lazy><p>End` });
      const verdict = await r.compare(page, `<!doctype html><div style="height: 3000px"></div><img src=http://127.0.0.1:${port}/a.svg alt=""><p>End`);
      assert.deepStrictEqual(verdict.reasons, []);
    } finally {
      server.close();
    }
  });

  test('Fetches files from other origins once per origin requesting them, as answers may depend on it', async () => {
    /** @type {Set<string>} */
    const origins = new Set();
    const server = http.createServer((request, response) => {
      const origin = String(request.headers.origin ?? '');
      origins.add(origin);
      response.writeHead(200, { 'access-control-allow-origin': origin, 'content-type': 'text/plain' }).end('fetched');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    try {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const html = `<!doctype html><p id=out>waiting</p><script>fetch("http://127.0.0.1:${port}/data").then((response) => response.text()).then((text) => { document.querySelector("#out").textContent = text; })</script>`;
      // From different origins: served locally, and at a URL of its own
      const pages = [createPage({ id: 'p.html', html }), createPage({ id: 'q.html', html, url: 'http://localhost:9/q.html' })];
      for (const page of pages) {
        const verdict = await r.compare(page, `${html}<!-- changed -->`);
        assert.strictEqual(verdict.equal, true);
      }
      assert.strictEqual(origins.size, 2);
    } finally {
      server.close();
    }
  });

  test('Fetches files from other origins once for all loads, naming those that didn’t load', async () => {
    /** @type {Record<string, number>} */
    const requests = {};
    const server = http.createServer((request, response) => {
      requests[request.url ?? ''] = (requests[request.url ?? ''] ?? 0) + 1;
      if (request.url === '/a.css') {
        response.writeHead(200, { 'content-type': 'text/css' }).end('p { color: red }');
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    try {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const links = `<link rel=stylesheet href=http://127.0.0.1:${port}/a.css><link rel=stylesheet href=http://127.0.0.1:${port}/missing.css>`;
      const page = createPage({ id: 'k.html', html: `<!doctype html>${links}<p>a</p>` });
      const verdict = await r.compare(page, `<!doctype html>${links}<p>a`);
      assert.strictEqual(verdict.equal, true);
      assert.strictEqual(requests['/a.css'], 1);
      assert.deepStrictEqual(verdict.failed, [`http://127.0.0.1:${port}/missing.css`]);
    } finally {
      server.close();
    }
  });
});

describe('`createRenderer` with allowed shifts', { skip: renderer ? false : `No browser: ${reason}` }, () => {
  test('Finds elements moving no more than allowed equal, but not text that differs or runs together', async () => {
    const found = await createRenderer({ viewports: [{ width: 800, height: 600 }], allowShift: 20 });
    const rendererShifting = /** @type {import('../src/render.js').Renderer} */ (found.renderer);
    try {
      const page = createPage({ id: 'i.html', html: '<!doctype html><p style="margin-left: 0">One two</p>' });
      assert.deepStrictEqual((await rendererShifting.compare(page, '<!doctype html><p style="margin-left: 8px">One two</p>')).reasons, []);
      assert.match((await rendererShifting.compare(page, '<!doctype html><p style="margin-left: 8px">One three</p>')).reasons.join(), /Text differs/);
      assert.match((await rendererShifting.compare(page, '<!doctype html><p style="margin-left: 8px">One<span>two</span></p>')).reasons.join(), /Text differs/);
      const pageTwo = createPage({ id: 'o.html', html: '<!doctype html><p style="margin-left: 0">One</p><p style="color: #000">Two</p>' });
      const verdict = await rendererShifting.compare(pageTwo, '<!doctype html><p style="margin-left: 8px">One</p><p style="color: #222">Two</p>');
      assert.deepStrictEqual(verdict.reasons, ['Moves elements by up to 8 px at 800×600 (e.g., p), and looks different beyond that']);
      assert.strictEqual(verdict.shift, null);
    } finally {
      await found.renderer?.close();
    }
  });
});

describe('`regionsMoved`', () => {
  test('Returns where the innermost elements that moved were and went, a pixel around', () => {
    const outer = { path: 'main', x: 0, y: 0, width: 100, height: 100 };
    const inner = { path: 'main > p', x: 10, y: 10, width: 20, height: 10 };
    const still = { path: 'main > div', x: 50, y: 50, width: 10, height: 10 };
    assert.deepStrictEqual(regionsMoved([outer, inner, still], [{ ...outer, x: 4 }, { ...inner, x: 14 }, still]), [{ x: 9, y: 9, width: 26, height: 12 }]);
  });
});

describe('`shiftOf`', () => {
  const box = { path: 'ul > li', x: 0, y: 0, width: 10, height: 10 };

  test('Returns how far elements moved or changed size at most, and where', () => {
    assert.deepStrictEqual(shiftOf([box, { ...box, path: 'p' }], [{ ...box, x: 3 }, { ...box, path: 'p', width: 5 }]), { shift: 5, path: 'p' });
    assert.deepStrictEqual(shiftOf([box], [box]), { shift: 0, path: '' });
  });

  test('Returns null where elements were added or removed', () => {
    assert.strictEqual(shiftOf([box], [box, box]), null);
    assert.strictEqual(shiftOf([box], [{ ...box, path: 'p' }]), null);
  });
});

describe('`createGuard`', () => {
  test('Rejects work that takes longer than the timeout, and all later work at once', async () => {
    const answered = createGuard(50);
    await assert.rejects(answered(() => new Promise(() => {})), /Browser stopped responding \(no answer within 50 ms\)/);
    let called = false;
    await assert.rejects(answered(async () => { called = true; }), /Browser stopped responding/);
    assert.strictEqual(called, false);
  });

  test('Lets later work through after errors other than timeouts, passing on results', async () => {
    const answered = createGuard(50);
    await assert.rejects(answered(async () => { throw new Error('Failed'); }), /Failed/);
    assert.strictEqual(await answered(async () => 'next'), 'next');
  });

  test('Rejects work that takes longer than a limit given for it', async () => {
    const answered = createGuard(60000);
    await assert.rejects(answered(() => new Promise(() => {}), 50), /Browser stopped responding \(no answer within 50 ms\)/);
  });
});

describe('`createLimit`', () => {
  test('Runs no more functions at once than allowed, in the order given, passing on results', async () => {
    const limit = createLimit(2);
    let active = 0;
    let peak = 0;
    /** @type {number[]} */
    const started = [];
    const results = await Promise.all([0, 1, 2, 3, 4].map((index) => limit(async () => {
      started.push(index);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return index * 10;
    })));
    assert.strictEqual(peak, 2);
    assert.deepStrictEqual(started, [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(results, [0, 10, 20, 30, 40]);
  });

  test('Frees the slot of functions that fail', async () => {
    const limit = createLimit(1);
    await assert.rejects(limit(async () => { throw new Error('Failed'); }), /Failed/);
    assert.strictEqual(await limit(async () => 'next'), 'next');
  });
});

describe('`combineOriginals`', () => {
  test('Keeps files either load of the original didn’t get, telling what stayed the same between loads', () => {
    const first = { shot: Buffer.from('a'), text: 'a', errors: [], blocked: ['a.css'], failed: [], boxes: [] };
    const second = { shot: Buffer.from('a'), text: 'b', errors: [], blocked: ['a.css', 'b.css'], failed: [], boxes: [] };
    const { capture, stableShot, stableText } = combineOriginals(first, second);
    assert.deepStrictEqual(capture.blocked, ['a.css', 'b.css']);
    assert.strictEqual(capture.text, 'a');
    assert.strictEqual(stableShot, true);
    assert.strictEqual(stableText, false);
  });

  test('Keeps script errors of either load of the original, as often as either had them', () => {
    const first = { shot: Buffer.from('a'), text: 'a', errors: ['A', 'B', 'B'], blocked: [], failed: [], boxes: [] };
    const second = { shot: Buffer.from('a'), text: 'a', errors: ['B', 'C'], blocked: [], failed: [], boxes: [] };
    assert.deepStrictEqual(combineOriginals(first, second).capture.errors.sort(), ['A', 'B', 'B', 'C']);
  });
});

describe('`serve`', () => {
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

  test('Serves files that symbolic links lead to outside the root only where allowed', async (t) => {
    const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-serve-')));
    try {
      const dirRoot = path.join(dir, 'site');
      await fs.promises.mkdir(dirRoot);
      await fs.promises.writeFile(path.join(dir, 'secret.txt'), 'secret');
      await fs.promises.writeFile(path.join(dirRoot, 'index.html'), '<p>a');
      try {
        await fs.promises.symlink(path.join(dir, 'secret.txt'), path.join(dirRoot, 'data.txt'));
        await fs.promises.symlink(path.join(dirRoot, 'index.html'), path.join(dirRoot, 'home.html'));
      } catch (err) {
        t.skip(`No symbolic links: ${err instanceof Error ? err.message : err}`);
        return;
      }
      /** @type {number[]} */
      const statuses = [];
      for (const followLinks of [false, true]) {
        const server = await serve(dirRoot, { followLinks });
        try {
          for (const pathname of ['/data.txt', '/home.html']) statuses.push((await fetch(`${server.origin}${pathname}`)).status);
        } finally {
          await server.close();
        }
      }
      assert.deepStrictEqual(statuses, [403, 200, 200, 200]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});