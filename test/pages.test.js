import { describe, test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPage, loadPages, samplePaths } from '../src/pages.js';

const dirSite = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');

describe('loadPages', () => {
  test('Finds HTML files in a directory, skipping ignored directories and other files', async () => {
    const pages = await loadPages([dirSite]);
    assert.deepStrictEqual(pages.map((page) => page.id).sort(), ['blog/app.html', 'index.html', 'poem.html']);
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
    assert.match(await app?.load('../js/app.js') ?? '', /is-open/);
    assert.match(await poem?.load('/css/site.css?v=2') ?? '', /pre-line/);
  });

  test('Returns null for remote, missing, and out-of-root references', async () => {
    const [page] = await loadPages([path.join(dirSite, 'index.html')]);
    assert.strictEqual(await page?.load('https://example.org/a.js'), null);
    assert.strictEqual(await page?.load('//example.org/a.js'), null);
    assert.strictEqual(await page?.load('missing.css'), null);
    assert.strictEqual(await page?.load('../../catalog.test.js'), null);
  });

  test('Returns null for every reference of in-memory pages', async () => {
    const page = createPage({ id: 'memory', html: '<p>a' });
    assert.strictEqual(await page.load('a.css'), null);
  });
});

describe('samplePaths', () => {
  test('Returns all paths when there are no more than requested', () => {
    assert.deepStrictEqual(samplePaths(['a', 'b'], 5), ['a', 'b']);
  });

  test('Spreads the sample across directories', () => {
    const paths = ['a/1.html', 'a/2.html', 'a/3.html', 'a/4.html', 'b/1.html', 'c/1.html'];
    const sample = samplePaths(paths, 3);
    assert.deepStrictEqual(sample.map((p) => p[0]).sort(), ['a', 'b', 'c']);
  });
});