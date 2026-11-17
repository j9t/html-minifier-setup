// Renders pages as written and as minified in a headless browser, and compares screenshots, text,
// and script errors—what catches CSS and scripts relying on what minification changed

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isInside } from './pages.js';
import { differencesOutside, looksSame } from './screenshots.js';

/**
 * @typedef {object} Verdict
 * @prop {boolean} equal
 * @prop {boolean} inconclusive Whether, at some viewport, nothing but script errors could be compared, and none differed
 * @prop {string[]} reasons Why the minified page isn’t equal
 * @prop {string[]} notes What limited the comparison
 * @prop {string[]} [blocked] Files pages requested but didn’t get, as symbolic links lead them outside the site
 * @prop {string[]} [failed] Style sheets, scripts, and fonts that didn’t load
 * @prop {number | null} [shift] How far elements move (or change size), in pixels, where that is all that differs
 */

/**
 * @typedef {object} Renderer
 * @prop {(page: import('./pages.js').Page, html: string) => Promise<Verdict>} compare
 * @prop {() => Promise<void>} close
 * @prop {Viewport[]} [viewports]
 * @prop {number} [allowShift] Pixels elements may move by
 * @prop {string} [browser] Name and major version
 */

/** @typedef {{name: string, channel?: string}} Browser */

/** @typedef {{width: number, height: number}} Viewport */
/** @typedef {{path: string, x: number, y: number, width: number, height: number}} Box */
/** @typedef {{shot: Buffer, text: string, errors: string[], blocked: string[], failed: string[], boxes: Box[]}} Capture */
/** @typedef {{status: number, headers: Record<string, string>, body: Buffer} | null} Stored */

// @@ Probe a higher or core-based default, weighing speed against memory and inconclusive renders
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

// Resource types whose loading failures change how pages look
const TYPES_FAILING = new Set(['font', 'script', 'stylesheet']);

// Headers that describe the transfer rather than the stored body
const HEADERS_TRANSFER = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

/** @param {Viewport} viewport */
const describeViewport = ({ width, height }) => `${width}×${height}`;

// Told apart from other errors, as only it means the browser may no longer answer
class Unresponsive extends Error {}

/**
 * Settles as the work does, or rejects where it takes longer than responsive pages or browsers
 * @template T
 * @param {Promise<T>} work
 * @param {number} limit
 * @param {string} [what] What stopped responding
 * @returns {Promise<T>}
 */
async function responsive(work, limit, what = 'Page') {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  // The work rejects as its context closes, which is no longer of interest
  work.catch(() => {});
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Unresponsive(`${what} stopped responding (no answer within ${limit} ms)`)), limit);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs browser work no longer than a responsive browser would take, and, once the browser
 * stops answering, rejects all later work at once rather than waiting again
 * @param {number} timeout
 */
export function createGuard(timeout) {
  /** @type {Unresponsive | null} */
  let errBrowser = null;
  /**
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  return async (work) => {
    if (errBrowser) throw errBrowser;
    try {
      return await responsive(work(), timeout, 'Browser');
    } catch (err) {
      if (err instanceof Unresponsive) errBrowser = err;
      throw err;
    }
  };
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

/**
 * Errors of the second list beyond those in the first, as often as they occur beyond
 * @param {string[]} known
 * @param {string[]} errors
 */
const errorsBeyond = (known, errors) => {
  const left = [...known];
  return errors.filter((error) => {
    const index = left.indexOf(error);
    if (index === -1) return true;
    left.splice(index, 1);
    return false;
  });
};

/**
 * Text without whitespace, as whitespace between elements may not show (e.g., between flex items)
 * @param {string} text
 */
const withoutWhitespace = (text) => text.replace(/\s+/g, '');

/**
 * Text with whitespace collapsed, as for words that run together or apart
 * @param {string} text
 */
const collapsed = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * How far the elements of one capture moved or changed size in the other, in pixels,
 * with the element moving most, or null where elements were added or removed
 * @param {Box[]} before
 * @param {Box[]} after
 * @returns {{shift: number, path: string} | null}
 */
export function shiftOf(before, after) {
  if (before.length !== after.length) return null;
  let found = { shift: 0, path: '' };
  for (const [index, box] of before.entries()) {
    const other = /** @type {Box} */ (after[index]);
    if (box.path !== other.path) return null;
    const shift = Math.max(Math.abs(box.x - other.x), Math.abs(box.y - other.y), Math.abs(box.width - other.width), Math.abs(box.height - other.height));
    if (shift > found.shift) found = { shift, path: box.path };
  }
  return found;
}

/**
 * Where the innermost elements that moved or changed size were and went, a pixel around, as what
 * moving them can change on screen
 * @param {Box[]} before
 * @param {Box[]} after Matching `before`, as where `shiftOf` finds a shift
 */
export function regionsMoved(before, after) {
  /** @type {[Box, Box][]} */
  const moved = before.flatMap((box, index) => {
    const other = /** @type {Box} */ (after[index]);
    return box.x === other.x && box.y === other.y && box.width === other.width && box.height === other.height ? [] : [/** @type {[Box, Box]} */ ([box, other])];
  });
  /** @param {Box} outer @param {Box} inner */
  const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  // By later elements alone, as descendants follow ancestors, which may share their boxes
  return moved
    .filter(([box], index) => !moved.slice(index + 1).some(([other]) => contains(box, other)))
    .map(([box, other]) => {
      const [left, top] = [Math.min(box.x, other.x) - 1, Math.min(box.y, other.y) - 1];
      const [right, bottom] = [Math.max(box.x + box.width, other.x + other.width) + 1, Math.max(box.y + box.height, other.y + other.height) + 1];
      return { x: left, y: top, width: right - left, height: bottom - top };
    });
}

/**
 * The original’s two captures as one, with what stayed the same between loads, every file either
 * load didn’t get, and every script error either load had
 * @param {Capture} first
 * @param {Capture} second
 */
export const combineOriginals = (first, second) => ({
  capture: {
    ...first,
    errors: [...first.errors, ...errorsBeyond(first.errors, second.errors)],
    blocked: [...new Set([...first.blocked, ...second.blocked])],
    failed: [...new Set([...first.failed, ...second.failed])]
  },
  stableShot: looksSame(first.shot, second.shot),
  stableText: withoutWhitespace(first.text) === withoutWhitespace(second.text)
});

// Playwright’s Chromium, or else browsers people tend to have, as original and minified pages are
// compared in the same browser
/** @type {Browser[]} */
const BROWSERS = [{ name: 'Chromium' }, { name: 'Chrome', channel: 'chrome' }, { name: 'Edge', channel: 'msedge' }];

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
 * @param {{viewports?: Viewport[], timeout?: number, browsers?: Browser[], concurrency?: number, followLinks?: boolean, allowShift?: number}} [settings] `concurrency`: pages rendered at once; `followLinks`: as for `serve`; `allowShift`: pixels elements may move or change size by, where nothing else differs
 * @returns {Promise<{renderer: Renderer | null, reason: string, missing?: boolean}>}
 */
export async function createRenderer({ viewports = VIEWPORTS_DEFAULT, timeout = 30000, browsers = BROWSERS, concurrency = CONCURRENCY_DEFAULT, followLinks = false, allowShift = 0 } = {}) {
  if (!viewports.length || viewports.some(({ width, height }) => !(width >= 1 && height >= 1))) {
    throw new Error(`Invalid viewports: ${JSON.stringify(viewports)} (at least one, each at least 1×1)`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`Invalid concurrency: ${concurrency} (pages rendered at once, at least 1)`);
  if (!Number.isInteger(allowShift) || allowShift < 0) throw new Error(`Invalid shift: ${allowShift} (pixels, at least 0)`);
  /** @type {typeof import('playwright') | null} */
  const playwright = await import('playwright').catch(() => null);
  if (!playwright) return { renderer: null, reason: 'Playwright isn’t installed' };
  /** @type {import('playwright').Browser | null} */
  let browser = null;
  // A server, rather than `launch`, for a process to end where the browser doesn’t close
  /** @type {import('playwright').BrowserServer | null} */
  let serverBrowser = null;
  let nameBrowser = '';
  for (const { name, channel } of browsers) {
    try {
      serverBrowser = await playwright.chromium.launchServer(channel ? { channel } : {});
      browser = await playwright.chromium.connect(serverBrowser.wsEndpoint());
      nameBrowser = `${name} ${browser.version().split('.')[0]}`;
      break;
    } catch {
      // Tries the next browser
      await serverBrowser?.kill();
      serverBrowser = null;
    }
  }
  if (!browser || !serverBrowser) {
    return { renderer: null, reason: `No browser found (${browsers.map(({ name }) => name).join(', ')})—\`npx playwright install chromium\` downloads Chromium`, missing: true };
  }
  const browserOpen = browser;
  const serverOpen = serverBrowser;
  const answered = createGuard(timeout);

  /** @type {Map<string | null, ReturnType<typeof serve>>} */
  const servers = new Map();
  /** @type {WeakMap<import('./pages.js').Page, Map<string, Promise<{capture: Capture, stableShot: boolean, stableText: boolean}>>>} */
  const originals = new WeakMap();
  /** @type {WeakMap<import('./pages.js').Page, Map<string, Promise<Verdict>>>} */
  const verdicts = new WeakMap();
  // Bounds all browser work, which is otherwise started at once
  const limit = createLimit(concurrency);
  // Files from elsewhere (e.g., CDNs), fetched once, for all loads to get the same
  /** @type {Map<string, Promise<Stored>>} */
  const stored = new Map();

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
      const context = await answered(() => browserOpen.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' }));
      try {
        const tab = await answered(() => context.newPage());
        /** @type {string[]} */
        const errors = [];
        tab.on('pageerror', (err) => errors.push(err.message));
        tab.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        /** @type {string[]} */
        const blocked = [];
        /** @type {string[]} */
        const failed = [];
        tab.on('response', (response) => {
          const target = new URL(response.url());
          if (!page.url && response.status() === 403 && target.origin === urlRequested.origin) {
            blocked.push(decodeURIComponent(target.pathname.slice(1)));
          } else if (response.status() >= 400 && TYPES_FAILING.has(response.request().resourceType())) {
            failed.push(response.url());
          }
        });
        tab.on('requestfailed', (request) => { if (TYPES_FAILING.has(request.resourceType())) failed.push(request.url()); });
        // Before the page’s route, which, added later, takes precedence
        await answered(() => tab.route((target) => /^https?:$/.test(target.protocol) && target.origin !== urlRequested.origin, async (route) => {
          const request = route.request();
          if (request.method() !== 'GET') return route.continue();
          // By origin, too, as answers may depend on it (e.g., CORS headers)
          const origin = await request.headerValue('origin');
          const key = origin ? `${origin} ${request.url()}` : request.url();
          let pending = stored.get(key);
          if (!pending) {
            pending = route.fetch({ timeout }).then(async (response) => ({
              status: response.status(),
              headers: Object.fromEntries(Object.entries(response.headers()).filter(([name]) => !HEADERS_TRANSFER.has(name))),
              body: await response.body()
            }), () => null);
            stored.set(key, pending);
          }
          const response = await pending;
          return response ? route.fulfill(response) : route.abort('failed');
        }));
        await answered(() => tab.route((target) => target.href === urlRequested.href, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })));
        await tab.goto(url, { waitUntil: 'load', timeout });
        // For fonts, lazy images (which full-page screenshots show, but may not have loaded yet),
        // and two frames, but not beyond the timeout, as any may never come
        await responsive(tab.evaluate(async (wait) => {
          const settled = (async () => {
            const images = [...document.images].filter((image) => image.loading === 'lazy');
            for (const image of images) image.loading = 'eager';
            await Promise.all(images.map((image) => image.complete ? null : new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', resolve, { once: true });
            })));
            await document.fonts?.ready;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })();
          await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, wait))]);
        }, timeout), 2 * timeout);
        const shot = await tab.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', timeout });
        const [text, boxes] = await responsive(tab.evaluate(() => {
          /** @param {Element} element */
          const name = (element) => `${element.localName}${element.id ? `#${element.id}` : ''}`;
          /** @type {Box[]} */
          const found = [];
          for (const element of document.body?.querySelectorAll('*') ?? []) {
            const { x, y, width, height } = element.getBoundingClientRect();
            if (!width || !height) continue;
            const names = [];
            for (let current = /** @type {Element | null} */ (element); current && current !== document.body && names.length < 4; current = current.parentElement) names.unshift(name(current));
            found.push({ path: names.join(' > '), x: x + scrollX, y: y + scrollY, width, height });
          }
          return /** @type {[string, Box[]]} */ ([document.body?.innerText ?? '', found]);
        }), timeout);
        return { shot, text, errors, blocked, failed: [...new Set(failed)], boxes };
      } finally {
        // Not waited for beyond the timeout, keeping the error the capture had, if any
        await answered(() => context.close()).catch(() => {});
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
        return combineOriginals(first, second);
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
      const looksDifferent = stableShot && !looksSame(before.shot, after.shot);
      // Words running together or apart count where the page looks different, too
      const textDiffers = stableText && (withoutWhitespace(before.text) !== withoutWhitespace(after.text) || (looksDifferent && collapsed(before.text) !== collapsed(after.text)));
      /** @type {number | null} */
      let shift = null;
      if (looksDifferent) {
        const moved = shiftOf(before.boxes, after.boxes);
        // Only where what looks different is where elements moved, while what looks different
        // without moving (e.g., colors) shows as such
        const explained = Boolean(moved && moved.shift > 0 && differencesOutside(before.shot, after.shot, regionsMoved(before.boxes, after.boxes)) === 0);
        // Moves of less than a pixel only show in anti-aliasing
        const allowed = moved && explained && !textDiffers && (moved.shift < 1 || moved.shift <= allowShift);
        if (moved && moved.shift >= 1 && !allowed) {
          const pixels = Math.ceil(moved.shift);
          if (explained) shift = pixels;
          reasons.push(`Moves elements by up to ${pixels} px at ${at} (e.g., ${moved.path})${explained ? '' : ', and looks different beyond that'}`);
        } else if (!allowed) {
          reasons.push(`Looks different at ${at}`);
        }
      }
      if (textDiffers) {
        reasons.push(`Text differs at ${at}: ${firstDifference(before.text, after.text)}`);
      }
      let errorsNew = errorsBeyond(before.errors, after.errors);
      // Confirmed by another load, as errors can come and go between loads (e.g., of embeds)
      if (errorsNew.length) {
        const errorsAgain = errorsBeyond(before.errors, (await capture(page, html, viewport)).errors);
        errorsNew = errorsNew.filter((error) => errorsAgain.includes(error));
      }
      for (const error of errorsNew) reasons.push(`New script error at ${at}: ${error.split('\n')[0]?.slice(0, 120)}`);
      // Only where moving is all that differs
      const shiftOnly = shift !== null && reasons.length === 1 ? shift : null;
      return { reasons, notes, blind, shift: shiftOnly, blocked: [...before.blocked, ...after.blocked], failed: [...before.failed, ...after.failed] };
    }));
    const reasons = [...new Set(results.flatMap((result) => result.reasons))];
    const notes = [...new Set(results.flatMap((result) => result.notes))];
    const inconclusive = results.some((result) => result.blind) && reasons.length === 0;
    const blocked = [...new Set(results.flatMap((result) => result.blocked))].sort();
    const failed = [...new Set(results.flatMap((result) => result.failed))].sort();
    const differing = results.filter((result) => result.reasons.length);
    const shift = differing.length && differing.every((result) => result.shift !== null) ? Math.max(...differing.map((result) => /** @type {number} */ (result.shift))) : null;
    return { equal: reasons.length === 0 && !inconclusive, inconclusive, reasons, notes, blocked, failed, shift };
  }

  return {
    reason: '',
    renderer: {
      viewports,
      allowShift,
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
        try {
          await answered(async () => {
            // Contexts first, as a browser waits for pages that stopped responding (Chrome: 30 s)
            await Promise.all(browserOpen.contexts().map((context) => context.close()));
            await serverOpen.close();
          });
        } catch {
          await serverOpen.kill();
        } finally {
          await Promise.all([...servers.values()].map(async (server) => (await server).close()));
        }
      }
    }
  };

}