import { promisify } from 'node:util';
import zlib from 'node:zlib';

// As in HTML Minifier’s benchmarks: common defaults for on-the-fly compression (quality 11, for
// files precompressed at build time, takes seconds per large file)
const GZIP_LEVEL = 6;
const BROTLI_QUALITY = 6;

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

/** @typedef {{raw: number, gzip: number, brotli: number}} Sizes */
/** @typedef {keyof Sizes} Metric */

/** @type {Metric[]} */
export const METRICS = ['raw', 'gzip', 'brotli'];

/** @type {Sizes} */
const SIZES_ZERO = Object.freeze({ raw: 0, gzip: 0, brotli: 0 });

/**
 * Size by one metric as servers would send it, compressed off the main thread
 * @param {string} text
 * @param {Metric} metric
 * @returns {Promise<number>}
 */
export async function sizeOf(text, metric) {
  const buffer = Buffer.from(text, 'utf8');
  if (metric === 'raw') return buffer.length;
  if (metric === 'gzip') return (await gzipCompress(buffer, { level: GZIP_LEVEL })).length;
  return (await brotliCompress(buffer, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length
    }
  })).length;
}

/**
 * @param {string} text
 * @returns {Promise<Sizes>}
 */
export async function measure(text) {
  const [raw, gzip, brotli] = await Promise.all([sizeOf(text, 'raw'), sizeOf(text, 'gzip'), sizeOf(text, 'brotli')]);
  return { raw, gzip, brotli };
}

/**
 * @param {Sizes} a
 * @param {Sizes} b
 * @returns {Sizes}
 */
export const addSizes = (a, b) => ({ raw: a.raw + b.raw, gzip: a.gzip + b.gzip, brotli: a.brotli + b.brotli });

/**
 * @param {Sizes[]} list
 * @returns {Sizes}
 */
export const sumSizes = (list) => list.reduce(addSizes, SIZES_ZERO);