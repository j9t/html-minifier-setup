import { describe, test } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import { countDifferences, decodePng, looksSame } from '../src/screenshots.js';

/**
 * A grayscale image from rows of values
 * @param {number[][]} rows
 * @returns {import('../src/screenshots.js').Image}
 */
const gray = (rows) => ({ width: rows[0]?.length ?? 0, height: rows.length, channels: 1, data: Uint8Array.from(rows.flat()) });

/**
 * A PNG of an RGB image, each row with the given filter
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} color
 * @param {number} filter Filter type, applied as “none” (0) or “sub” (1)
 */
function encodePng(width, height, color, filter = 0) {
  /** @param {string} type @param {Buffer} body */
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length);
    head.write(type, 4, 'latin1');
    // Decoders that check CRCs aren’t in use, so zeros do
    return Buffer.concat([head, body, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = filter;
    for (let x = 0; x < width; x++) {
      const pixel = color(x, y);
      const left = x ? color(x - 1, y) : [0, 0, 0];
      for (let channel = 0; channel < 3; channel++) {
        const value = /** @type {number} */ (pixel[channel]);
        row[1 + x * 3 + channel] = filter === 1 ? (value - /** @type {number} */ (left[channel]) + 256) & 0xff : value;
      }
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** @param {number} x @param {number} y @returns {[number, number, number]} */
const gradient = (x, y) => [x * 40, y * 50, 200];

describe('`decodePng`', () => {
  test('Decodes RGB images, whatever the row filters', () => {
    for (const filter of [0, 1]) {
      const image = decodePng(encodePng(4, 3, gradient, filter));
      assert.ok(image);
      assert.deepStrictEqual([image.width, image.height, image.channels], [4, 3, 3]);
      assert.deepStrictEqual([...image.data.subarray((2 * 4 + 3) * 3, (2 * 4 + 3) * 3 + 3)], gradient(3, 2));
    }
  });

  test('Returns null for what isn’t a PNG', () => {
    assert.strictEqual(decodePng(Buffer.from('not a png')), null);
  });
});

describe('`countDifferences`', () => {
  test('Ignores edges that moved by less than a pixel', () => {
    const before = gray([[255, 255, 128, 0, 0], [255, 255, 128, 0, 0], [255, 255, 128, 0, 0]]);
    const after = gray([[255, 255, 90, 0, 0], [255, 255, 90, 0, 0], [255, 255, 90, 0, 0]]);
    assert.strictEqual(countDifferences(before, after), 0);
  });

  test('Counts shapes that moved by more than a pixel', () => {
    const before = gray([[0, 0, 255, 255, 255, 255], [0, 0, 255, 255, 255, 255]]);
    const after = gray([[255, 255, 255, 255, 0, 0], [255, 255, 255, 255, 0, 0]]);
    assert.strictEqual(countDifferences(before, after), 8);
  });

  test('Counts slight color changes on flat areas', () => {
    const before = gray([[51, 51, 51], [51, 51, 51]]);
    const after = gray([[68, 68, 68], [68, 68, 68]]);
    assert.strictEqual(countDifferences(before, after), 6);
  });

  test('Returns null for images of different sizes', () => {
    assert.strictEqual(countDifferences(gray([[0, 0]]), gray([[0], [0]])), null);
  });
});

describe('`looksSame`', () => {
  test('Finds the same bytes the same, even where they aren’t PNGs', () => {
    assert.strictEqual(looksSame(Buffer.from('a'), Buffer.from('a')), true);
  });

  test('Compares PNGs by their pixels, not their encoding', () => {
    assert.strictEqual(looksSame(encodePng(4, 3, gradient, 0), encodePng(4, 3, gradient, 1)), true);
    assert.strictEqual(looksSame(encodePng(4, 3, gradient), encodePng(4, 3, (x, y) => [x * 40, y * 50, 0])), false);
  });

  test('Finds what can’t be decoded different where the bytes differ', () => {
    assert.strictEqual(looksSame(Buffer.from('a'), Buffer.from('b')), false);
  });
});