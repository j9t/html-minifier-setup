// Minifies what the pool in workers.js sends, answering with the output or the error message

import { parentPort } from 'node:worker_threads';
import { minify } from 'html-minifier';

const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort);

port.on('message', async (/** @type {{html: string, options: Record<string, unknown>}} */ { html, options }) => {
  try {
    port.postMessage({ output: await minify(html, { ...options, log: () => {} }) });
  } catch (err) {
    port.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
});