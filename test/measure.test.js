import { describe, test } from 'node:test';
import assert from 'node:assert';
import { addSizes, measure, sizeOf, sumSizes } from '../src/measure.js';

describe('`measure`', () => {
  test('Counts raw bytes as UTF-8', async () => {
    assert.strictEqual((await measure('aé')).raw, 3);
  });

  test('Reports smaller compressed than raw sizes for repetitive text', async () => {
    const sizes = await measure('<p>a</p>'.repeat(200));
    assert.ok(sizes.gzip < sizes.raw);
    assert.ok(sizes.brotli < sizes.raw);
  });

  test('Agrees with sizeOf for each metric', async () => {
    const text = '<p>Hello, world</p>'.repeat(20);
    const sizes = await measure(text);
    assert.deepStrictEqual(await Promise.all([sizeOf(text, 'raw'), sizeOf(text, 'gzip'), sizeOf(text, 'brotli')]), [sizes.raw, sizes.gzip, sizes.brotli]);
  });

  test('Returns zero raw bytes for empty text', async () => {
    assert.strictEqual((await measure('')).raw, 0);
  });
});

describe('`addSizes` and `sumSizes`', () => {
  test('Adds per metric', () => {
    const a = { raw: 10, gzip: 5, brotli: 4 };
    const b = { raw: 3, gzip: 2, brotli: 1 };
    assert.deepStrictEqual(addSizes(a, b), { raw: 13, gzip: 7, brotli: 5 });
    assert.deepStrictEqual(sumSizes([a, b, a]), { raw: 23, gzip: 12, brotli: 9 });
  });
});