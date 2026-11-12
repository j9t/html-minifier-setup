import { describe, test } from 'node:test';
import assert from 'node:assert';
import { loadEquivalence } from '../src/equivalence.js';

const equivalence = await loadEquivalence();
const SKIP = equivalence ? false : 'No equivalence check (needs a sibling HTML Minifier checkout)';

describe('loadEquivalence', () => {
  test('Returns a check or nothing, never failing', () => {
    assert.ok(equivalence === null || typeof equivalence.compare === 'function');
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