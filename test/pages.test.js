import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPage, findOutsideLinks, loadPages, samplePaths } from '../src/pages.js';

const dirSite = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');

describe('`loadPages`', () => {
  test('Finds HTML files in a directory, skipping ignored directories and other files', async () => {
    const pages = await loadPages([dirSite]);
    assert.deepStrictEqual(pages.map((page) => page.id).sort(), ['blog/app.html', 'index.html', 'poem.html']);
  });

  test('Tells how many pages it found, beyond those sampled', async () => {
    const pages = await loadPages([dirSite], { sample: 2 });
    assert.strictEqual(pages.length, 2);
    assert.strictEqual(pages.found, 3);
    assert.strictEqual((await loadPages([dirSite])).found, 3);
  });

  test('Loads single files with their directory as root', async () => {
    const [page] = await loadPages([path.join(dirSite, 'poem.html')]);
    assert.strictEqual(page?.id, 'poem.html');
    assert.strictEqual(page?.root, dirSite);
    assert.match(page?.html ?? '', /Roses are red/);
  });

  test('Fails on inputs that don’t exist', async () => {
    await assert.rejects(loadPages([path.join(dirSite, 'missing.html')]), /missing\.html/);
  });

  test('Reads all files for the extension `*`, and extensions as HTML Minifier does', async () => {
    const all = await loadPages([dirSite], { extensions: ['*'] });
    assert.ok(all.some((page) => page.id === 'notes.txt'));
    const dotted = await loadPages([dirSite], { extensions: ['.HTML'] });
    assert.deepStrictEqual(dotted.map((page) => page.id).sort(), ['blog/app.html', 'index.html', 'poem.html']);
  });

  test('Reads the file extensions HTML Minifier reads by default', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-pages-'));
    try {
      for (const name of ['a.html', 'b.htm', 'c.shtml', 'd.shtm', 'e.php']) await fs.promises.writeFile(path.join(dir, name), '<p>x');
      assert.deepStrictEqual((await loadPages([dir])).map((page) => page.id).sort(), ['a.html', 'b.htm', 'c.shtml', 'd.shtm']);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test('Limits pages to the sample size', async () => {
    const pages = await loadPages([dirSite], { sample: 2 });
    assert.strictEqual(pages.length, 2);
  });
});

describe('Page resources', () => {
  test('Resolves relative and root-relative references within the root', async () => {
    const pages = await loadPages([dirSite]);
    const app = pages.find((page) => page.id === 'blog/app.html');
    const poem = pages.find((page) => page.id === 'poem.html');
    assert.match((await app?.load('../js/app.js'))?.text ?? '', /is-open/);
    assert.match((await poem?.load('/css/site.css?v=2'))?.text ?? '', /pre-line/);
  });

  test('Returns null for remote, missing, and out-of-root references', async () => {
    const [page] = await loadPages([path.join(dirSite, 'index.html')]);
    assert.strictEqual(await page?.load('https://example.org/a.js'), null);
    assert.strictEqual(await page?.load('//example.org/a.js'), null);
    assert.strictEqual(await page?.load('missing.css'), null);
    assert.strictEqual(await page?.load('../../catalog.test.js'), null);
  });

  test('Resolves references relative to the resource that makes them', () => {
    const local = createPage({ id: 'blog/app.html', html: '', resources: {} });
    assert.strictEqual(local.resolve('b.css', '../css/a.css'), '/css/b.css');
    assert.strictEqual(local.resolve('/b.css', 'a.css'), '/b.css');
    assert.strictEqual(local.resolve('https://example.org/b.css', 'a.css'), 'https://example.org/b.css');
    const remote = createPage({ id: 'x', html: '', url: 'https://example.com/blog/' });
    assert.strictEqual(remote.resolve('b.css', '../css/a.css'), 'https://example.com/css/b.css');
  });

  test('Follows redirects within the origin only, telling where they end', async () => {
    /** @param {(request: http.IncomingMessage, response: http.ServerResponse) => void} handler */
    const listen = (handler) => new Promise((resolve) => {
      const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
    });
    const other = /** @type {http.Server} */ (await listen((_, response) => response.end('elsewhere')));
    const portOther = /** @type {import('node:net').AddressInfo} */ (other.address()).port;
    const site = /** @type {http.Server} */ (await listen((request, response) => {
      if (request.url === '/away.css') response.writeHead(302, { location: `http://127.0.0.1:${portOther}/x.css` }).end();
      else if (request.url === '/moved.css') response.writeHead(301, { location: '/here.css' }).end();
      else response.end('here');
    }));
    const portSite = /** @type {import('node:net').AddressInfo} */ (site.address()).port;
    try {
      const page = createPage({ id: 'p', html: '', url: `http://127.0.0.1:${portSite}/` });
      assert.strictEqual(await page.load('away.css'), null);
      assert.deepStrictEqual(await page.load('moved.css'), { text: 'here', ref: `http://127.0.0.1:${portSite}/here.css` });
    } finally {
      for (const server of [other, site]) {
        server.closeAllConnections();
        server.close();
      }
    }
  });

  test('Returns null for every reference of in-memory pages', async () => {
    const page = createPage({ id: 'memory', html: '<p>a' });
    assert.strictEqual(await page.load('a.css'), null);
  });
});

describe('`findOutsideLinks`', () => {
  test('Finds symbolic links that lead outside the root, skipping ignored directories and links within the root', async (t) => {
    const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-links-')));
    try {
      const dirRoot = path.join(dir, 'site');
      await fs.promises.mkdir(path.join(dirRoot, 'node_modules'), { recursive: true });
      await fs.promises.mkdir(path.join(dir, 'shared'));
      await fs.promises.writeFile(path.join(dir, 'secret.txt'), 'secret');
      await fs.promises.writeFile(path.join(dirRoot, 'index.html'), '<p>a');
      try {
        await fs.promises.symlink(path.join(dir, 'secret.txt'), path.join(dirRoot, 'data.txt'));
        await fs.promises.symlink(path.join(dir, 'shared'), path.join(dirRoot, 'shared'), 'dir');
        await fs.promises.symlink(path.join(dirRoot, 'index.html'), path.join(dirRoot, 'home.html'));
        await fs.promises.symlink(path.join(dir, 'secret.txt'), path.join(dirRoot, 'node_modules', 'data.txt'));
      } catch (err) {
        t.skip(`No symbolic links: ${err instanceof Error ? err.message : err}`);
        return;
      }
      const links = await findOutsideLinks(dirRoot);
      assert.deepStrictEqual(links.sort((a, b) => a.link.localeCompare(b.link)), [
        { link: path.join(dirRoot, 'data.txt'), target: path.join(dir, 'secret.txt') },
        { link: path.join(dirRoot, 'shared'), target: path.join(dir, 'shared') }
      ]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('`samplePaths`', () => {
  test('Returns all paths when there are no more than requested', () => {
    assert.deepStrictEqual(samplePaths(['a', 'b'], 5), ['a', 'b']);
  });

  test('Spreads the sample across directories', () => {
    const paths = ['a/1.html', 'a/2.html', 'a/3.html', 'a/4.html', 'b/1.html', 'c/1.html'];
    const sample = samplePaths(paths, 3);
    assert.deepStrictEqual(sample.map((p) => p[0]).sort(), ['a', 'b', 'c']);
  });

  test('Spreads the sample across sections before the folders within them', () => {
    const posts = Array.from({ length: 100 }, (_, index) => `blog/${index + 10}/index.html`);
    const paths = ['index.html', 'about/index.html', 'docs/a/index.html', 'docs/b/index.html', ...posts];
    const sample = samplePaths(paths, 6);
    assert.deepStrictEqual(sample.filter((p) => !p.startsWith('blog/')).sort(), ['about/index.html', 'docs/a/index.html', 'docs/b/index.html', 'index.html']);
    // Rather than the first posts
    const picked = sample.filter((p) => p.startsWith('blog/'));
    assert.strictEqual(picked.length, 2);
    assert.notDeepStrictEqual(picked.sort(), ['blog/10/index.html', 'blog/11/index.html']);
  });

  test('Spreads picks across the folders of a section', () => {
    const posts = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, '0')}/index.html`);
    const numbers = samplePaths(posts, 10).map((p) => Number(p.slice(0, 3))).sort((a, b) => a - b);
    // At most a fifth of the range apart from the next pick
    numbers.forEach((number, index) => assert.ok((numbers[index + 1] ?? 100) - number <= 20, String(numbers)));
  });

  test('Samples large sites quickly', () => {
    const paths = Array.from({ length: 50000 }, (_, index) => [`page${index}.html`, `post${index}/index.html`]).flat();
    const start = performance.now();
    assert.strictEqual(samplePaths(paths, 20).length, 20);
    assert.ok(performance.now() - start < 1000, `${Math.round(performance.now() - start)} ms`);
  });

  test('Picks the same sample each time', () => {
    const paths = Array.from({ length: 50 }, (_, index) => `s${index % 3}/p${index}/index.html`);
    assert.deepStrictEqual(samplePaths(paths, 7), samplePaths([...paths].reverse(), 7));
  });

  test('Keeps the order of paths within each directory', () => {
    const paths = ['a/1.html', 'a/2.html', 'b/1.html', 'b/2.html'];
    assert.deepStrictEqual(samplePaths(paths, 2), ['a/1.html', 'b/1.html']);
  });
});