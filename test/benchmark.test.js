import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baselineMismatches, createPhaseTimer, FILE_BASELINE, formatDelta, main, median, parseArgs, spread } from '../benchmark/benchmark.js';

describe('Benchmark helpers', () => {
  test('Computes medians and spreads', () => {
    assert.strictEqual(median([3, 1, 2]), 2);
    assert.strictEqual(median([4, 1, 3, 2]), 2.5);
    assert.strictEqual(spread([100, 110, 125]), 25);
  });

  test('Formats deltas against the baseline', () => {
    assert.strictEqual(formatDelta(90, 100), ' (−10.0%)');
    assert.strictEqual(formatDelta(110, 100), ' (+10.0%)');
    assert.strictEqual(formatDelta(100, 0), '');
  });
});

describe('`createPhaseTimer`', () => {
  test('Adds up time per phase as phases change and recur', () => {
    let clock = 0;
    const timer = createPhaseTimer(() => clock);
    timer.enter('evaluate');
    clock = 10;
    timer.enter('evaluate');
    clock = 30;
    timer.enter('render');
    clock = 35;
    timer.enter('contribute');
    clock = 36;
    timer.enter('render');
    clock = 40;
    assert.deepStrictEqual(Object.fromEntries(timer.stop()), { evaluate: 30, render: 9, contribute: 1 });
  });
});

describe('`parseArgs` and `baselineMismatches`', () => {
  test('Defaults to the fixtures, rendered', () => {
    const args = parseArgs([]);
    assert.match(args.inputs[0] ?? '', /fixtures[\\/]site$/);
    assert.strictEqual(args.render, true);
  });

  test('Fails on unknown arguments and invalid iterations', () => {
    assert.throws(() => parseArgs(['--fast']), /Unknown argument/);
    assert.throws(() => parseArgs(['--iterations=0']), /positive integer/);
  });

  test('Names settings that keep runs from being compared', () => {
    const args = parseArgs(['--no-render', '--iterations=2']);
    const baseline = { created: '', git: null, inputs: args.inputs, iterations: 3, render: true, phases: {} };
    assert.deepStrictEqual(baselineMismatches(baseline, args), ['render true → false', 'iterations 3 → 2']);
  });
});

describe('`main`', () => {
  test('Times phases and saves a baseline to compare later runs with', async () => {
    const dirWork = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-benchmark-'));
    try {
      /** @type {string[]} */
      const lines = [];
      await main({ argv: ['--no-render', '--iterations=1', '--save'], dirWork, log: (line) => lines.push(line) });
      const baseline = JSON.parse(fs.readFileSync(path.join(dirWork, FILE_BASELINE), 'utf8'));
      assert.ok(baseline.phases.evaluate.time >= 0);
      assert.strictEqual(baseline.render, false);
      lines.length = 0;
      await main({ argv: ['--no-render', '--iterations=1'], dirWork, log: (line) => lines.push(line) });
      assert.match(lines.join('\n'), /Evaluating options .*\((?:[+−][\d.]+|±0)%\)/);
      assert.match(lines.join('\n'), /^Total/m);
    } finally {
      fs.rmSync(dirWork, { recursive: true, force: true });
    }
  });
});