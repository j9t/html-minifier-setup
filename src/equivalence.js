// HTML Minifier’s own check that output means the same to browsers as its source, which catches
// minifier bugs rather than what a site relies on—used where available, never duplicated here

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {object} Equivalence
 * @prop {string} source Where the check came from
 * @prop {(name: string) => boolean} supports Whether the check models what an option changes—others would show as differences
 * @prop {(input: string, output: string, options: Record<string, unknown>) => string[]} compare Differences found, if any
 */

// @@ Import `html-minifier/equivalence` alone once HTML Minifier exports its check
const SPECIFIER_EXPORT = 'html-minifier/equivalence';
const FILE_SIBLING = fileURLToPath(new URL('../../html-minifier/test/equivalence/compare.js', import.meta.url));
// Lists the options the check is run with
const FILE_SIBLING_RUNNER = fileURLToPath(new URL('../../html-minifier/test/equivalence/runner.js', import.meta.url));

/**
 * @param {unknown} difference
 * @returns {string}
 */
function describe(difference) {
  if (difference && typeof difference === 'object' && 'kind' in difference) {
    const { kind, input, output } = /** @type {{kind: string, input?: string, output?: string}} */ (difference);
    const clip = (/** @type {string | undefined} */ text) => (text ?? '').split('\u0001').join(' ').slice(0, 80);
    return `${kind}: ${clip(input)} → ${clip(output)}`;
  }
  return String(difference);
}

/** @param {URL} url */
function versionOf(url) {
  try {
    return JSON.parse(fs.readFileSync(url, 'utf8')).version ?? '?';
  } catch {
    return '?';
  }
}

/**
 * The installed HTML Minifier’s check, or that of an HTML Minifier checkout next to this
 * package; `null` where neither is available
 * @returns {Promise<Equivalence | null>}
 */
export async function loadEquivalence() {
  /** @type {[string, () => Promise<any>][]} */
  const sources = [
    [SPECIFIER_EXPORT, () => import(SPECIFIER_EXPORT)],
    [FILE_SIBLING, async () => {
      if (!fs.existsSync(FILE_SIBLING) || !fs.existsSync(FILE_SIBLING_RUNNER)) return null;
      const [compare, runner] = await Promise.all([import(pathToFileURL(FILE_SIBLING).href), import(pathToFileURL(FILE_SIBLING_RUNNER).href)]);
      return { ...runner, ...compare };
    }]
  ];
  for (const [source, load] of sources) {
    const module = await load().catch(() => null);
    if (typeof module?.compareMarkup !== 'function' || !module.OPTIONS_STRUCTURAL || !module.OPTIONS_CODE) continue;
    const supported = new Set([...Object.keys(module.OPTIONS_STRUCTURAL), ...Object.keys(module.OPTIONS_CODE)]);
    return {
      source: source === FILE_SIBLING ? `${source} (HTML Minifier ${versionOf(new URL('../../package.json', pathToFileURL(FILE_SIBLING)))}, minifying with installed ${versionOf(new URL(import.meta.resolve('html-minifier/package.json')))})` : source,
      supports: (name) => supported.has(name),
      compare: (input, output, options) => /** @type {unknown[]} */ (module.compareMarkup(input, output, options)).map(describe)
    };
  }
  return null;
}