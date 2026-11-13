// Minifies on worker threads, so that pages minify in parallel and the main thread stays free for
// static checks, rendering, and progress

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { minify } from 'html-minifier';

// One core is left to the main thread; more workers mostly add memory, as each loads the minifier
const SIZE_DEFAULT = Math.max(1, Math.min(os.availableParallelism() - 1, 8));
const FILE_WORKER = new URL('./minify-worker.js', import.meta.url);

/**
 * @typedef {object} Job
 * @prop {string} html
 * @prop {Record<string, unknown>} options
 * @prop {(output: string) => void} resolve
 * @prop {(err: Error) => void} reject
 */

/** @typedef {{worker: Worker, job: Job | null}} Slot */

/**
 * @param {string} html
 * @param {Record<string, unknown>} options
 */
const minifyHere = (html, options) => minify(html, { ...options, log: () => {} });

/**
 * Workers started as needed, up to `size`, which let the process exit while idle
 * @param {{size?: number}} [settings]
 */
export function createMinifierPool({ size = SIZE_DEFAULT } = {}) {
  /** @type {Slot[]} */
  const slots = [];
  /** @type {Job[]} */
  const queue = [];

  /** @param {Slot} slot */
  const release = (slot) => {
    slot.job = null;
    slot.worker.unref();
    pump();
  };

  const spawn = () => {
    /** @type {Slot} */
    // Without the parent’s Node flags, some of which (e.g., `--input-type`) workers can’t take
    const slot = { worker: new Worker(FILE_WORKER, { execArgv: [] }), job: null };
    slot.worker.unref();
    slot.worker.on('message', (/** @type {{output?: string, error?: string}} */ data) => {
      const { job } = slot;
      if (data.error === undefined) {
        job?.resolve(data.output ?? '');
      } else {
        job?.reject(new Error(data.error));
      }
      release(slot);
    });
    // Where a worker fails as a whole (e.g., out of memory), its job fails and others take over
    slot.worker.on('error', (/** @type {Error} */ err) => {
      const index = slots.indexOf(slot);
      if (index !== -1) slots.splice(index, 1);
      slot.job?.reject(err);
      slot.job = null;
      pump();
    });
    slots.push(slot);
    return slot;
  };

  function pump() {
    while (queue.length) {
      const slot = slots.find((candidate) => !candidate.job) ?? (slots.length < size ? spawn() : null);
      if (!slot) return;
      const job = /** @type {Job} */ (queue.shift());
      slot.job = job;
      slot.worker.ref();
      slot.worker.postMessage({ html: job.html, options: job.options });
    }
  }

  return {
    size,
    /**
     * @param {string} html
     * @param {Record<string, unknown>} options `log` is left out, as workers log nothing
     * @returns {Promise<string>}
     */
    minify(html, options) {
      const rest = { ...options };
      delete rest.log;
      // Functions, for one, can’t be sent to workers
      try {
        structuredClone(rest);
      } catch {
        return minifyHere(html, rest);
      }
      return new Promise((resolve, reject) => {
        queue.push({ html, options: rest, resolve, reject });
        pump();
      });
    },
    async close() {
      const jobs = [...queue.splice(0), ...slots.flatMap((slot) => slot.job ? [slot.job] : [])];
      for (const job of jobs) job.reject(new Error('Minifier pool closed'));
      await Promise.all(slots.splice(0).map((slot) => {
        slot.job = null;
        return slot.worker.terminate();
      }));
    }
  };
}

/** @type {ReturnType<typeof createMinifierPool> | null} */
let poolShared = null;

/**
 * Minifies on a pool shared by all runs, which needs no closing
 * @param {string} html
 * @param {Record<string, unknown>} options
 */
export const minifyInWorkers = (html, options) => (poolShared ??= createMinifierPool()).minify(html, options);