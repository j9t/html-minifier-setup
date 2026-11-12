// Renders pages as written and as minified in a headless browser, and compares screenshots, text,
// and script errors—what catches CSS and scripts relying on what minification changed

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isInside } from './pages.js';

/**
 * @typedef {object} Verdict
 * @prop {boolean} equal
 * @prop {boolean} inconclusive Whether, at some viewport, nothing but script errors could be compared, and none differed
 * @prop {string[]} reasons Why the minified page isn’t equal
 * @prop {string[]} notes What limited the comparison
 * @prop {string[]} [blocked] Files pages requested but didn’t get, as symbolic links lead them outside the site
 */

/**
 * @typedef {object} Renderer
 * @prop {(page: import('./pages.js').Page, html: string) => Promise<Verdict>} compare
 * @prop {() => Promise<void>} close
 * @prop {Viewport[]} [viewports]
 * @prop {string} [browser] Name and major version
 */

/** @typedef {{name: string, channel?: string}} Browser */

/** @typedef {{width: number, height: number}} Viewport */
/** @typedef {{shot: Buffer, text: string, errors: string[], blocked: string[]}} Capture */

export const CONCURRENCY_DEFAULT = 4;

/** @type {Viewport[]} */
export const VIEWPORTS_DEFAULT = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];

/** @type {Record<string, string>} */
const TYPES = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/** @param {Viewport} viewport */
const describeViewport = ({ width, height }) => `${width}×${height}`;

/**
 * Settles as the page work does, or rejects where it takes longer than a responsive page would
 * @template T
 * @param {Promise<T>} work
 * @param {number} limit
 * @returns {Promise<T>}
 */
async function responsive(work, limit) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  // The work rejects as its context closes, which is no longer of interest
  work.catch(() => {});
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Page stopped responding (no answer within ${limit} ms)`)), limit);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serves a directory on a local port, so that pages load their resources as on the web
 * @param {string | null} root
 * @param {{followLinks?: boolean}} [settings] `followLinks`: serve what symbolic links lead to outside the root
 * @returns {Promise<{origin: string, close: () => Promise<void>}>}
 */
export async function serve(root, { followLinks = false } = {}) {
  const rootReal = root ? await fs.promises.realpath(root).catch(() => null) : null;
  const server = http.createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const file = root ? path.join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname) : null;
    const inside = Boolean(root && file && isInside(root, file));
    // Forbidden rather than not found, for captures to tell what they didn’t get
    const fileReal = inside && !followLinks ? await fs.promises.realpath(/** @type {string} */ (file)).catch(() => null) : null;
    if (fileReal && !(rootReal && isInside(rootReal, fileReal))) {
      response.writeHead(403).end();
      return;
    }
    const body = inside && file ? await fs.promises.readFile(file).catch(() => null) : null;
    if (!body || !file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

/**
 * The first line each text has that the other lacks, as a hint at what changed
 * @param {string} a
 * @param {string} b
 */
function firstDifference(a, b) {
  const [linesA, linesB] = [a, b].map((text) => text.split('\n').map((line) => line.trim()).filter(Boolean));
  const [setA, setB] = [new Set(linesA), new Set(linesB)];
  const lost = linesA?.find((line) => !setB.has(line));
  const gained = linesB?.find((line) => !setA.has(line));
  /** @param {string | undefined} line */
  const quote = (line) => line === undefined ? 'nothing' : `“${line.length > 40 ? `${line.slice(0, 39)}…` : line}”`;
  return lost === undefined && gained === undefined ? 'line breaks or spacing changed' : `${quote(lost)} became ${quote(gained)}`;
}

// Playwright’s Chromium, or else browsers people tend to have, as original and minified pages are
// compared in the same browser
/** @type {Browser[]} */
export const BROWSERS = [{ name: 'Chromium' }, { name: 'Chrome', channel: 'chrome' }, { name: 'Edge', channel: 'msedge' }];

/** The path of Playwright’s command line interface, if installed */
export function playwrightCli() {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  } catch {
    return null;
  }
}

/**
 * Downloads Playwright’s Chromium, showing the installer’s output
 * @returns {Promise<boolean>}
 */
export const installChromium = () => new Promise((resolve) => {
  const fileCli = playwrightCli();
  if (!fileCli) return resolve(false);
  const child = spawn(process.execPath, [fileCli, 'install', 'chromium'], { stdio: 'inherit' });
  child.on('error', () => resolve(false));
  child.on('close', (code) => resolve(code === 0));
});

/**
 * Runs functions given no more than `limit` at a time, in the order given
 * @param {number} limit
 */
export function createLimit(limit) {
  let active = 0;
  /** @type {(() => void)[]} */
  const queue = [];
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  return async (fn) => {
    if (active < limit) {
      active++;
    } else {
      await new Promise((resolve) => queue.push(() => resolve(undefined)));
    }
    try {
      return await fn();
    } finally {
      // Hands the slot to the next in line, if any
      const next = queue.shift();
      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

/**
 * A renderer using the first browser that starts, or, where none does, why not
 * @param {{viewports?: Viewport[], timeout?: number, browsers?: Browser[], concurrency?: number, followLinks?: boolean}} [settings] `concurrency`: pages rendered at once; `followLinks`: as for `serve`
 * @returns {Promise<{renderer: Renderer | null, reason: string, missing?: boolean}>}
 */
export async function createRenderer({ viewports = VIEWPORTS_DEFAULT, timeout = 30000, browsers = BROWSERS, concurrency = CONCURRENCY_DEFAULT, followLinks = false } = {}) {
  if (!viewports.length || viewports.some(({ width, height }) => !(width >= 1 && height >= 1))) {
    throw new Error(`Invalid viewports: ${JSON.stringify(viewports)} (at least one, each at least 1×1)`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`Invalid concurrency: ${concurrency} (pages rendered at once, at least 1)`);
  /** @type {typeof import('playwright') | null} */
  const playwright = await import('playwright').catch(() => null);
  if (!playwright) return { renderer: null, reason: 'Playwright isn’t installed' };
  /** @type {import('playwright').Browser | null} */
  let browser = null;
  let nameBrowser = '';
  for (const { name, channel } of browsers) {
    try {
      browser = await playwright.chromium.launch(channel ? { channel } : {});
      nameBrowser = `${name} ${browser.version().split('.')[0]}`;
      break;
    } catch {
      // Tries the next browser
    }
  }
  if (!browser) {
    return { renderer: null, reason: `No browser found (${browsers.map(({ name }) => name).join(', ')})—\`npx playwright install chromium\` downloads Chromium`, missing: true };
  }
  const browserOpen = browser;

  /** @type {Map<string | null, ReturnType<typeof serve>>} */
  const servers = new Map();
  /** @type {WeakMap<import('./pages.js').Page, Map<string, Promise<{capture: Capture, stableShot: boolean, stableText: boolean}>>>} */
  const originals = new WeakMap();
  /** @type {WeakMap<import('./pages.js').Page, Map<string, Promise<Verdict>>>} */
  const verdicts = new WeakMap();
  // Bounds all browser work, which is otherwise started at once
  const limit = createLimit(concurrency);

  /** @param {import('./pages.js').Page} page */
  async function urlOf(page) {
    if (page.url) return page.url;
    let server = servers.get(page.root);
    if (!server) {
      server = serve(page.root, { followLinks });
      servers.set(page.root, server);
    }
    return `${(await server).origin}/${page.id.split('/').map(encodeURIComponent).join('/')}`;
  }

  /**
   * @param {import('./pages.js').Page} page
   * @param {string} html
   * @param {Viewport} viewport
   * @returns {Promise<Capture>}
   */
  async function capture(page, html, viewport) {
    const url = await urlOf(page);
    // Requests leave out fragments
    const urlRequested = new URL(url);
    urlRequested.hash = '';
    return limit(async () => {
      const context = await browserOpen.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      try {
        const tab = await context.newPage();
        /** @type {string[]} */
        const errors = [];
        tab.on('pageerror', (err) => errors.push(err.message));
        tab.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        /** @type {string[]} */
        const blocked = [];
        if (!page.url) {
          tab.on('response', (response) => {
            const target = new URL(response.url());
            if (response.status() === 403 && target.origin === urlRequested.origin) blocked.push(decodeURIComponent(target.pathname.slice(1)));
          });
        }
        await tab.route((target) => target.href === urlRequested.href, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
        await tab.goto(url, { waitUntil: 'load', timeout });
        // For fonts and two frames, but not beyond the timeout, as either may never come
        await responsive(tab.evaluate(async (wait) => {
          const settled = (async () => {
            await document.fonts?.ready;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })();
          await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, wait))]);
        }, timeout), 2 * timeout);
        const shot = await tab.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', timeout });
        const text = await responsive(tab.evaluate(() => document.body?.innerText ?? ''), timeout);
        return { shot, text, errors, blocked };
      } finally {
        await context.close();
      }
    });
  }

  /**
   * Renders the original twice, as what differs between loads (e.g., animations, ads, or
   * dates) can’t tell minification apart
   * @param {import('./pages.js').Page} page
   * @param {Viewport} viewport
   */
  function original(page, viewport) {
    const byViewport = originals.get(page) ?? new Map();
    originals.set(page, byViewport);
    const key = describeViewport(viewport);
    let pending = byViewport.get(key);
    if (!pending) {
      pending = (async () => {
        const [first, second] = await Promise.all([capture(page, page.html, viewport), capture(page, page.html, viewport)]);
        return { capture: first, stableShot: first.shot.equals(second.shot), stableText: first.text === second.text };
      })();
      byViewport.set(key, pending);
    }
    return pending;
  }

  /**
   * @param {import('./pages.js').Page} page
   * @param {string} html
   * @returns {Promise<Verdict>}
   */
  async function compareUncached(page, html) {
    const results = await Promise.all(viewports.map(async (viewport) => {
      /** @type {string[]} */
      const reasons = [];
      /** @type {string[]} */
      const notes = [];
      let blind = false;
      const at = describeViewport(viewport);
      const [{ capture: before, stableShot, stableText }, after] = await Promise.all([original(page, viewport), capture(page, html, viewport)]);
      if (!stableShot && !stableText) {
        blind = true;
        notes.push(`Looks and reads different between loads at ${at}, so only script errors were compared`);
      } else if (!stableShot) {
        notes.push(`Looks different between loads at ${at}, so screenshots weren’t compared`);
      } else if (!stableText) {
        notes.push(`Text differs between loads at ${at}, so text wasn’t compared`);
      }
      if (stableShot && !before.shot.equals(after.shot)) {
        reasons.push(`Looks different at ${at}`);
      }
      if (stableText && before.text !== after.text) {
        reasons.push(`Text differs at ${at}: ${firstDifference(before.text, after.text)}`);
      }
      const known = [...before.errors];
      for (const error of after.errors) {
        const index = known.indexOf(error);
        if (index === -1) {
          reasons.push(`New script error at ${at}: ${error.split('\n')[0]?.slice(0, 120)}`);
        } else {
          known.splice(index, 1);
        }
      }
      return { reasons, notes, blind, blocked: [...before.blocked, ...after.blocked] };
    }));
    const reasons = [...new Set(results.flatMap((result) => result.reasons))];
    const notes = [...new Set(results.flatMap((result) => result.notes))];
    const inconclusive = results.some((result) => result.blind) && reasons.length === 0;
    const blocked = [...new Set(results.flatMap((result) => result.blocked))].sort();
    return { equal: reasons.length === 0 && !inconclusive, inconclusive, reasons, notes, blocked };
  }

  return {
    reason: '',
    renderer: {
      viewports,
      browser: nameBrowser,
      compare(page, html) {
        // The same output, as different options may produce, renders the same
        const byHtml = verdicts.get(page) ?? new Map();
        verdicts.set(page, byHtml);
        let verdict = byHtml.get(html);
        if (!verdict) {
          verdict = compareUncached(page, html);
          byHtml.set(html, verdict);
        }
        return verdict;
      },
      async close() {
        await browserOpen.close();
        await Promise.all([...servers.values()].map(async (server) => (await server).close()));
      }
    }
  };

}