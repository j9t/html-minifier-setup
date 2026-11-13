#!/usr/bin/env node

// Times HTML Minifier Setup by phase, to check changes to its speed against a saved baseline.
// Runs as the CLI does (equivalence check and presets included), on the test fixtures unless
// other inputs are given; times are each phase’s fastest iteration.
//
// Usage:
//   npm run benchmark: Run; if a baseline exists, show deltas
//   npm run benchmark -- --save: Run and save the result as the baseline
//   npm run benchmark -- --no-render: Skip the render check, timing what doesn’t need a browser
//   npm run benchmark -- --iterations=5
//   npm run benchmark -- path/to/site: Time other pages (files, directories, or URLs)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEquivalence } from '../src/equivalence.js';
import { loadPages } from '../src/pages.js';
import { TITLES } from '../src/progress.js';
import { createRenderer } from '../src/render.js';
import { customize } from '../src/select.js';

const dirBenchmark = path.dirname(fileURLToPath(import.meta.url));

export const FILE_BASELINE = 'benchmark-baseline.json';
const INPUTS_DEFAULT = [path.join(dirBenchmark, '..', 'test', 'fixtures', 'site')];
const ITERATIONS_DEFAULT = 3;

// One warm-up run (discarded) before the timed iterations
const WARMUP = 1;

// Above this much spread between the fastest and slowest iteration, a delta may be noise—where
// a phase takes long enough for that to matter
const NOISE_WARN_PCT = 15;
const NOISE_WARN_MIN_MS = 100;

/** @typedef {import('../src/progress.js').ProgressEvent['phase']} Phase */
/** @typedef {{inputs: string[], iterations: number, render: boolean, save: boolean}} Args */
/** @typedef {{time: number, median: number, spread: number}} Timing */
/** @typedef {{created: string, git: {branch: string, commit: string} | null, inputs: string[], iterations: number, render: boolean, phases: Partial<Record<Phase, Timing>>}} Baseline */

/** @param {number[]} times */
const fastest = (times) => Math.min(...times);

/** @param {number[]} times */
export function median(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Spread between the fastest and slowest time, as a percentage of the fastest
 * @param {number[]} times
 */
export const spread = (times) => fastest(times) > 0 ? (Math.max(...times) / fastest(times) - 1) * 100 : 0;

/**
 * Adds up how long each phase lasts, as progress events report phases changing
 * @param {() => number} [now]
 */
export function createPhaseTimer(now = () => performance.now()) {
  /** @type {Map<Phase, number>} */
  const durations = new Map();
  /** @type {Phase | null} */
  let phase = null;
  let start = 0;
  const close = () => {
    if (phase) durations.set(phase, (durations.get(phase) ?? 0) + now() - start);
  };
  return {
    /** @param {Phase} next */
    enter(next) {
      if (next === phase) return;
      close();
      phase = next;
      start = now();
    },
    /** @returns {Map<Phase, number>} */
    stop() {
      close();
      phase = null;
      return durations;
    }
  };
}

/**
 * @param {number} time
 * @param {number} timeBase
 */
export function formatDelta(time, timeBase) {
  if (!timeBase) return '';
  const change = (time / timeBase - 1) * 100;
  return Math.abs(change) < 0.05 ? ' (±0%)' : ` (${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%)`;
}

/**
 * Settings that would make a comparison with the baseline not apples-to-apples
 * @param {Baseline} baseline
 * @param {Args} args
 */
export function baselineMismatches(baseline, args) {
  /** @type {string[]} */
  const mismatches = [];
  if (baseline.inputs.join() !== args.inputs.join()) mismatches.push(`inputs ${baseline.inputs.join(', ')} → ${args.inputs.join(', ')}`);
  if (baseline.render !== args.render) mismatches.push(`render ${baseline.render} → ${args.render}`);
  if (baseline.iterations !== args.iterations) mismatches.push(`iterations ${baseline.iterations} → ${args.iterations}`);
  return mismatches;
}

/**
 * @param {string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {Args} */
  const args = { inputs: [], iterations: ITERATIONS_DEFAULT, render: true, save: false };
  for (const arg of argv) {
    if (arg === '--save') {
      args.save = true;
    } else if (arg === '--no-render') {
      args.render = false;
    } else if (arg.startsWith('--iterations=')) {
      const count = Number(arg.slice('--iterations='.length));
      if (!Number.isInteger(count) || count < 1) throw new Error(`Not a positive integer: ${arg}`);
      args.iterations = count;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      args.inputs.push(/^https?:\/\//i.test(arg) ? arg : path.resolve(arg));
    }
  }
  if (!args.inputs.length) args.inputs = INPUTS_DEFAULT;
  return args;
}

/**
 * Durations of one run, by phase, including reading pages and starting the browser
 * @param {Args} args
 */
async function timeRun(args) {
  const timer = createPhaseTimer();
  timer.enter('read');
  const pages = await loadPages(args.inputs);
  timer.enter('start');
  const rendering = args.render ? await createRenderer() : { renderer: null, reason: 'skipped as asked' };
  if (args.render && !rendering.renderer) throw new Error(`No render check: ${rendering.reason}`);
  const equivalence = await loadEquivalence();
  // Minifying and analyzing pages comes before the first progress event
  timer.enter('evaluate');
  try {
    await customize(pages, { renderer: rendering.renderer, equivalence, onProgress: (event) => timer.enter(event.phase) });
    // Before the browser closes, which no phase stands for
    return timer.stop();
  } finally {
    await rendering.renderer?.close();
  }
}

const gitInfo = () => {
  try {
    const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: dirBenchmark, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { branch: git('rev-parse', '--abbrev-ref', 'HEAD'), commit: git('rev-parse', '--short', 'HEAD') };
  } catch {
    return null;
  }
};

/** @param {{argv?: string[], dirWork?: string, log?: (line: string) => void}} [settings] */
export async function main({ argv = process.argv.slice(2), dirWork = dirBenchmark, log = console.log } = {}) {
  const args = parseArgs(argv);
  const fileBaseline = path.join(dirWork, FILE_BASELINE);
  /** @type {Baseline | null} */
  const baseline = await fs.readFile(fileBaseline, 'utf8').then(JSON.parse).catch(() => null);
  const mismatches = baseline ? baselineMismatches(baseline, args) : [];
  if (mismatches.length) log(`Warning: Not comparing with the baseline, which differs in ${mismatches.join('; ')}`);
  const compared = baseline && !mismatches.length ? baseline : null;

  /** @type {Map<Phase, number[]>} */
  const times = new Map();
  for (let run = 0; run < WARMUP + args.iterations; run++) {
    log(run < WARMUP ? 'Warming up…' : `Iteration ${run - WARMUP + 1} of ${args.iterations}…`);
    const durations = await timeRun(args);
    if (run < WARMUP) continue;
    for (const [phase, duration] of durations) times.set(phase, [...times.get(phase) ?? [], duration]);
  }

  /** @type {Partial<Record<Phase, Timing>>} */
  const phases = {};
  log('');
  let total = 0;
  let totalBase = 0;
  for (const [phase, list] of times) {
    const timing = { time: Math.round(fastest(list)), median: Math.round(median(list)), spread: Math.round(spread(list)) };
    phases[phase] = timing;
    const timeBase = compared?.phases[phase]?.time ?? 0;
    total += timing.time;
    totalBase += timeBase;
    const noisy = timing.spread > NOISE_WARN_PCT && timing.time >= NOISE_WARN_MIN_MS ? ' (noisy)' : '';
    log(`${TITLES[phase].padEnd(24)} ${`${timing.time} ms`.padStart(10)}${formatDelta(timing.time, timeBase).padEnd(10)}  median ${timing.median} ms, ±${timing.spread}%${noisy}`);
  }
  log(`${'Total'.padEnd(24)} ${`${total} ms`.padStart(10)}${compared ? formatDelta(total, totalBase) : ''}`);

  if (args.save) {
    /** @type {Baseline} */
    const saved = { created: new Date().toISOString(), git: gitInfo(), inputs: args.inputs, iterations: args.iterations, render: args.render, phases };
    await fs.writeFile(fileBaseline, `${JSON.stringify(saved, null, 2)}\n`);
    log(`\nSaved ${path.relative(process.cwd(), fileBaseline)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}