// Compares screenshots as people would see them, rather than byte by byte: Pixels that only
// differ in anti-aliasing, as where text moves by a fraction of a pixel, don’t count

import zlib from 'node:zlib';

/** @typedef {{width: number, height: number, channels: number, data: Uint8Array}} Image */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// How far pixels on edges, where neighbors contrast at least as much, may lie outside their
// neighbors’ range, as glyphs rasterize differently at other sub-pixel offsets
const EDGE_CONTRAST = 64;
const EDGE_TOLERANCE = 32;

// Channels by PNG color type, for 8-bit images: grayscale, RGB, grayscale with alpha, RGBA
/** @type {Record<number, number>} */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * @param {number} a
 * @param {number} b
 * @param {number} c
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decodes 8-bit, non-interlaced PNGs without palette, as browsers take screenshots
 * @param {Buffer} buffer
 * @returns {Image | null} Null for other images
 */
export function decodePng(buffer) {
  if (buffer.length < SIGNATURE.length || !buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return null;
  let width = 0;
  let height = 0;
  let channels = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for (let offset = SIGNATURE.length; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      const [depth = 0, color = 0, , , interlace = 0] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || !CHANNELS[color]) return null;
      [width, height, channels] = [body.readUInt32BE(0), body.readUInt32BE(4), CHANNELS[color] ?? 0];
    } else if (type === 'IDAT') {
      chunks.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += length + 12;
  }
  if (!width || !height) return null;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(chunks));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride;
    const source = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const value = /** @type {number} */ (raw[source + x]);
      const left = x >= channels ? /** @type {number} */ (data[row + x - channels]) : 0;
      const up = y ? /** @type {number} */ (data[row - stride + x]) : 0;
      const upLeft = y && x >= channels ? /** @type {number} */ (data[row - stride + x - channels]) : 0;
      const predicted = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : 0;
      data[row + x] = (value + predicted) & 0xff;
    }
  }
  return { width, height, channels, data };
}

/**
 * Whether the pixel of one image lies, channel by channel, within the range of the pixel and its
 * neighbors in the other (with some leeway on edges), as anti-aliased edges do where shapes move
 * by less than a pixel—without changing by as much as its neighbors contrast, as only moves of
 * a pixel or more flip pixels (e.g., of inverted patterns)
 * @param {Image} image
 * @param {Image} other
 * @param {number} x
 * @param {number} y
 */
function withinNeighbors(image, other, x, y) {
  const { width, height, channels } = image;
  const at = (y * width + x) * channels;
  for (let channel = 0; channel < channels; channel++) {
    const value = /** @type {number} */ (image.data[at + channel]);
    let min = 255;
    let max = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const [nx, ny] = [x + dx, y + dy];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbor = /** @type {number} */ (other.data[(ny * width + nx) * channels + channel]);
        if (neighbor < min) min = neighbor;
        if (neighbor > max) max = neighbor;
      }
    }
    const tolerance = max - min >= EDGE_CONTRAST ? EDGE_TOLERANCE : 0;
    if (value < min - tolerance || value > max + tolerance) return false;
    const change = Math.abs(value - /** @type {number} */ (other.data[at + channel]));
    if (change && change >= max - min) return false;
  }
  return true;
}

/**
 * The pixels that differ beyond anti-aliasing, or null where the images differ in size or format
 * @param {Image} a
 * @param {Image} b
 * @param {(x: number, y: number) => boolean} [accounted] Pixels to leave out (e.g., where elements moved)
 */
export function countDifferences(a, b, accounted = () => false) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return null;
  const { width, height, channels } = a;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      let same = true;
      for (let channel = 0; channel < channels && same; channel++) same = a.data[at + channel] === b.data[at + channel];
      if (!same && !accounted(x, y) && !(withinNeighbors(a, b, x, y) && withinNeighbors(b, a, x, y))) count++;
    }
  }
  return count;
}

/**
 * The pixels two screenshots differ in beyond anti-aliasing, leaving out the given regions,
 * or null where they can’t be compared
 * @param {Buffer} a
 * @param {Buffer} b
 * @param {{x: number, y: number, width: number, height: number}[]} regions
 */
export function differencesOutside(a, b, regions) {
  const [imageA, imageB] = [decodePng(a), decodePng(b)];
  if (!imageA || !imageB) return null;
  const { width, height } = imageA;
  const mask = new Uint8Array(width * height);
  for (const region of regions) {
    const [left, top] = [Math.max(0, Math.floor(region.x)), Math.max(0, Math.floor(region.y))];
    const [right, bottom] = [Math.min(width, Math.ceil(region.x + region.width)), Math.min(height, Math.ceil(region.y + region.height))];
    for (let y = top; y < bottom; y++) mask.fill(1, y * width + left, y * width + Math.max(left, right));
  }
  return countDifferences(imageA, imageB, (x, y) => mask[y * width + x] === 1);
}

/**
 * Whether two screenshots look the same, beyond anti-aliasing
 * @param {Buffer} a
 * @param {Buffer} b
 */
export function looksSame(a, b) {
  if (a.equals(b)) return true;
  const [imageA, imageB] = [decodePng(a), decodePng(b)];
  return Boolean(imageA && imageB && countDifferences(imageA, imageB) === 0);
}