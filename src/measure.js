import zlib from 'node:zlib';

/** @typedef {{raw: number, gzip: number, brotli: number}} Sizes */
/** @typedef {keyof Sizes} Metric */

/** @type {Metric[]} */
export const METRICS = ['raw', 'gzip', 'brotli'];

/** @type {Sizes} */
export const SIZES_ZERO = Object.freeze({ raw: 0, gzip: 0, brotli: 0 });

/**
 * Size by one metric as servers would send it, compressed at the highest level
 * @param {string} text
 * @param {Metric} metric
 * @returns {number}
 */
export function sizeOf(text, metric) {
  const buffer = Buffer.from(text, 'utf8');
  if (metric === 'raw') return buffer.length;
  if (metric === 'gzip') return zlib.gzipSync(buffer, { level: 9 }).length;
  return zlib.brotliCompressSync(buffer, {
    params: {
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length
    }
  }).length;
}

/**
 * @param {string} text
 * @returns {Sizes}
 */
export const measure = (text) => ({ raw: sizeOf(text, 'raw'), gzip: sizeOf(text, 'gzip'), brotli: sizeOf(text, 'brotli') });

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