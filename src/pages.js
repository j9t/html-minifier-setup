import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} Page
 * @prop {string} id How the page is named in reports
 * @prop {string} html
 * @prop {string | null} url Where the page lives online, if read from there
 * @prop {string | null} file
 * @prop {string | null} root Directory that root-relative references resolve against
 * @prop {(ref: string) => Promise<Resource | null>} load Reads a resource the page references, where local or same-origin
 * @prop {(ref: string, base: string) => string} resolve Turns a reference made by a resource the page references into one made by the page
 */

/** @typedef {{text: string, ref: string}} Resource `ref` tells where the resource ended up after redirects */

// As HTML Minifier’s
export const EXTENSIONS_DEFAULT = ['html', 'htm', 'shtml', 'shtm'];
const MAX_REDIRECTS = 5;
const RE_SCHEME = /^[a-z][\w+.-]*:|^\/\//i;
const RE_URL_INPUT = /^https?:\/\//i;

/**
 * Whether a path lies within the root (or is the root)
 * @param {string} root
 * @param {string} target
 */
export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * @param {{id: string, html: string, url?: string | null, file?: string | null, root?: string | null, resources?: Record<string, string>}} spec
 * @returns {Page}
 */
export function createPage({ id, html, url = null, file = null, root = null, resources }) {
  /** @type {Map<string, Promise<Resource | null>>} */
  const cache = new Map();
  /**
   * @param {string} ref
   * @returns {Promise<Resource | null>}
   */
  const read = async (ref) => {
    if (url) return fetchSameOrigin(url, ref);
    const text = resources ? resources[ref] ?? null : file && root ? await readLocal(file, root, ref) : null;
    return text === null ? null : { text, ref };
  };
  // Local pages resolve as if served from their root
  const location = url ?? `http://page.invalid/${id.split('/').map(encodeURIComponent).join('/')}`;
  return {
    id,
    html,
    url,
    file,
    root,
    resolve(ref, base) {
      const target = new URL(ref, new URL(base, location));
      return url || target.origin !== new URL(location).origin ? target.href : `${target.pathname}${target.search}`;
    },
    load(ref) {
      let pending = cache.get(ref);
      if (!pending) {
        pending = read(ref).catch(() => null);
        cache.set(ref, pending);
      }
      return pending;
    }
  };
}

/**
 * @param {string} file
 * @param {string} root
 * @param {string} ref
 */
async function readLocal(file, root, ref) {
  if (RE_SCHEME.test(ref)) return null;
  const clean = decodeURI(ref.replace(/[?#].*$/s, ''));
  if (!clean) return null;
  const target = clean.startsWith('/') ? path.join(root, clean) : path.resolve(path.dirname(file), clean);
  if (!isInside(root, target)) return null;
  return fs.promises.readFile(target, 'utf8');
}

/**
 * @param {string} pageUrl
 * @param {string} ref
 * @returns {Promise<Resource | null>}
 */
async function fetchSameOrigin(pageUrl, ref) {
  const { origin } = new URL(pageUrl);
  let target = new URL(ref, pageUrl);
  // Redirects are followed one by one, so that none leads to another origin
  for (let redirects = 0; redirects <= MAX_REDIRECTS && target.origin === origin; redirects++) {
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status > 399 || !location) return response.ok ? { text: await response.text(), ref: target.href } : null;
    await response.body?.cancel();
    target = new URL(location, target);
  }
  return null;
}

// Golden ratio, whose multiples spread picks evenly over a range
const SPREAD = 0.6180339887;

/**
 * Items in an order whose every start is spread across them, rather than their first ones
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function spread(items) {
  /** @type {Set<number>} */
  const picked = new Set();
  // Bounded, as the last gaps can take a while to hit
  for (let step = 0; step < 4 * items.length && picked.size < items.length; step++) {
    picked.add(Math.floor(((step * SPREAD) % 1) * items.length));
  }
  for (let index = 0; index < items.length; index++) picked.add(index);
  return [...picked].map((index) => /** @type {T} */ (items[index]));
}

/**
 * Takes from each list in turn, up to `limit` items
 * @param {string[][]} lists
 * @param {number} limit
 */
function interleave(lists, limit) {
  /** @type {string[]} */
  const items = [];
  let active = lists.filter((list) => list.length);
  for (let round = 0; active.length && items.length < limit; round++) {
    for (const list of active) {
      if (items.length < limit) items.push(/** @type {string} */ (list[round]));
    }
    active = active.filter((list) => list.length > round + 1);
  }
  return items;
}

/**
 * Picks pages across a site’s sections first and then across the folders within them, so that
 * a sample covers its templates rather than one section’s first pages; the same paths always
 * give the same sample
 * @param {string[]} paths
 * @param {number} count
 * @returns {string[]}
 */
export function samplePaths(paths, count) {
  if (paths.length <= count) return paths;
  /** @typedef {{files: string[], folders: Map<string, Folder>}} Folder */
  /** @type {Folder} */
  const root = { files: [], folders: new Map() };
  for (const item of [...paths].sort()) {
    const segments = item.split(/[\\/]/);
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      let next = folder.folders.get(segment);
      if (!next) {
        next = { files: [], folders: new Map() };
        folder.folders.set(segment, next);
      }
      folder = next;
    }
    folder.files.push(item);
  }
  /**
   * The first `count` pages of the folder, in the order they’re picked
   * @param {Folder} folder
   * @returns {string[]}
   */
  const order = (folder) => interleave([spread(folder.files), ...spread([...folder.folders.values()]).map(order)], count);
  return order(root);
}

/**
 * @param {string} dir
 * @param {string[]} extensions
 * @param {string[]} ignore
 * @returns {Promise<string[]>}
 */
async function walk(dir, extensions, ignore) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ignore.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full, extensions, ignore));
    } else if (entry.isFile() && (extensions.includes('*') || extensions.includes(path.extname(entry.name).slice(1).toLowerCase()))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Symbolic links under the root that lead outside it, which the render check follows only where
 * allowed, as a page’s scripts could send on what they lead to
 * @param {string} root
 * @param {string[]} [ignore]
 * @returns {Promise<{link: string, target: string}[]>}
 */
export async function findOutsideLinks(root, ignore = ['node_modules']) {
  const rootReal = await fs.promises.realpath(root);
  /** @type {{link: string, target: string}[]} */
  const links = [];
  /** @param {string} dir */
  const visit = async (dir) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') || ignore.includes(entry.name)) continue;
      const link = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(link);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.promises.realpath(link).catch(() => null);
        if (target && !isInside(rootReal, target)) links.push({ link, target });
      }
    }
  };
  await visit(root);
  return links;
}

/**
 * Reads pages from files, directories, and URLs, sampled where there are more
 * @param {string[]} inputs
 * @param {{extensions?: string[], ignore?: string[], sample?: number}} [settings]
 * @returns {Promise<Page[] & {found: number}>} `found`: pages found before sampling
 */
export async function loadPages(inputs, { extensions = EXTENSIONS_DEFAULT, ignore = ['node_modules'], sample = 20 } = {}) {
  // As HTML Minifier reads them, with `*` for all files
  const extensionsRead = extensions.map((ext) => ext.trim().replace(/^\.+/, '').toLowerCase());
  /** @type {{file: string, root: string}[]} */
  const files = [];
  /** @type {string[]} */
  const urls = [];
  for (const input of inputs) {
    if (RE_URL_INPUT.test(input)) {
      urls.push(input);
      continue;
    }
    const resolved = path.resolve(input);
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (!stat) throw new Error(`Not found: ${input}`);
    if (stat.isDirectory()) {
      for (const file of await walk(resolved, extensionsRead, ignore)) files.push({ file, root: resolved });
    } else {
      files.push({ file: resolved, root: path.dirname(resolved) });
    }
  }

  const keys = samplePaths([...files.map(({ file }) => file), ...urls], sample);
  const pages = await Promise.all(keys.map(async (key) => {
    if (RE_URL_INPUT.test(key)) {
      const response = await fetch(key, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Couldn’t fetch ${key}: ${response.status}`);
      return createPage({ id: key, html: await response.text(), url: response.url });
    }
    const { root } = /** @type {{file: string, root: string}} */ (files.find(({ file }) => file === key));
    return createPage({
      id: path.relative(root, key).split(path.sep).join('/'),
      html: await fs.promises.readFile(key, 'utf8'),
      file: key,
      root
    });
  }));
  return Object.assign(pages, { found: files.length + urls.length });
}