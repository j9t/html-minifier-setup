import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEquivalence } from '../src/equivalence.js';

const equivalence = await loadEquivalence();
const SKIP = equivalence ? false : 'No equivalence check (needs a sibling HTML Minifier checkout)';

describe('`loadEquivalence`', () => {
  test('Returns a check or nothing, never failing', () => {
    assert.ok(equivalence === null || typeof equivalence.compare === 'function');
  });

  test('Returns nothing where installed, next to HTML Minifier as dependency', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-equivalence-'));
    try {
      const dirModules = path.join(dir, 'node_modules');
      const fileModule = path.join(dirModules, 'html-minifier-setup', 'src', 'equivalence.js');
      const dirCheck = path.join(dirModules, 'html-minifier', 'test', 'equivalence');
      await fs.promises.mkdir(path.dirname(fileModule), { recursive: true });
      await fs.promises.mkdir(dirCheck, { recursive: true });
      await fs.promises.copyFile(new URL('../src/equivalence.js', import.meta.url), fileModule);
      // A check that would load, were HTML Minifier to publish its tests
      await fs.promises.writeFile(path.join(dirCheck, 'compare.js'), 'export const compareMarkup = () => [];');
      await fs.promises.writeFile(path.join(dirCheck, 'runner.js'), 'export const OPTIONS_STRUCTURAL = {}; export const OPTIONS_CODE = {};');
      const { loadEquivalence: loadInstalled } = await import(pathToFileURL(fileModule).href);
      assert.strictEqual(await loadInstalled(), null);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test('Passes output that means the same', { skip: SKIP }, () => {
    assert.deepStrictEqual(equivalence?.compare('<p>a  b</p>', '<p>a b</p>', { collapseWhitespace: true }), []);
  });

  test('Supports the options HTML Minifier’s check models, and no others', { skip: SKIP }, () => {
    assert.strictEqual(equivalence?.supports('collapseWhitespace'), true);
    assert.strictEqual(equivalence?.supports('removeUnusedCSS'), false);
  });

  test('Flags output that means something else', { skip: SKIP }, () => {
    assert.ok((equivalence?.compare('<p>a</p>', '<p>b</p>', {}) ?? []).length > 0);
  });
});