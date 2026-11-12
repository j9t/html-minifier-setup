import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createProgress, formatLine, visibleLength } from '../src/progress.js';

/**
 * A stream that records what is written
 * @param {boolean} isTTY
 */
const fakeStream = (isTTY) => {
  const chunks = /** @type {string[]} */ ([]);
  return {
    chunks,
    isTTY,
    columns: 80,
    /** @param {string} chunk */
    write(chunk) {
      chunks.push(chunk);
      return true;
    }
  };
};

const ESC = '\u001b';
const RE_ANSI = new RegExp(`${ESC}\\[[\\d;?]*[A-Za-z]`);

describe('formatLine', () => {
  test('Shows the phase, a bar, the share done, the detail, and the time taken', () => {
    const line = formatLine({ title: 'Evaluating options', detail: 'removeComments', current: 13, total: 26, elapsed: 83000, frame: 0, columns: 100, color: false });
    assert.match(line, /Evaluating options/);
    assert.match(line, /50%/);
    assert.match(line, /removeComments/);
    assert.match(line, /1:23/);
    assert.match(line, /━/);
  });

  test('Leaves out the bar where the total is unknown', () => {
    const line = formatLine({ title: 'Reading pages', detail: '', elapsed: 0, frame: 0, columns: 100, color: false });
    assert.doesNotMatch(line, /━|%/);
  });

  test('Fits the terminal width, shortening the detail first', () => {
    const line = formatLine({ title: 'Evaluating options', detail: 'a very long detail '.repeat(10), current: 1, total: 2, elapsed: 0, frame: 0, columns: 60, color: true });
    assert.ok(visibleLength(line) <= 59, `${visibleLength(line)} columns`);
    assert.match(line, /Evaluating options/);
  });

  test('Fits narrow terminals by shortening the title, keeping the time', () => {
    const line = formatLine({ title: 'Measuring contributions', detail: 'x', current: 1, total: 4, elapsed: 83000, frame: 0, columns: 20, color: true });
    assert.ok(visibleLength(line) <= 19, `${visibleLength(line)} columns`);
    assert.match(line, /Measuring ?…/);
    assert.match(line, /1:23/);
  });

  test('Uses no escape codes without color', () => {
    const line = formatLine({ title: 'Rendering', detail: 'x', current: 1, total: 4, elapsed: 0, frame: 3, columns: 80, color: false });
    assert.doesNotMatch(line, RE_ANSI);
  });

  test('Colors with the terminal’s own palette, never fixed black or white', () => {
    const line = formatLine({ title: 'Rendering', detail: 'x', current: 1, total: 4, elapsed: 0, frame: 3, columns: 80, color: true });
    assert.match(line, RE_ANSI);
    assert.doesNotMatch(line, new RegExp(`${ESC}\\[(?:3[07]|9[07]|38;)`));
  });
});

describe('createProgress', () => {
  test('Animates on terminals and restores the cursor when done', () => {
    const stream = fakeStream(true);
    const progress = createProgress({ stream, color: false });
    progress.update({ phase: 'evaluate', detail: 'collapseWhitespace', current: 1, total: 4 });
    progress.stop();
    const output = stream.chunks.join('');
    assert.ok(output.includes(`${ESC}[?25l`));
    assert.ok(output.includes(`${ESC}[?25h`));
    assert.match(output, /Evaluating options/);
  });

  test('Marks finished phases with a check and their time', () => {
    const stream = fakeStream(true);
    const progress = createProgress({ stream, color: false });
    progress.update({ phase: 'evaluate', detail: 'a', current: 1, total: 1 });
    progress.update({ phase: 'contribute', detail: 'b', current: 1, total: 1 });
    progress.stop();
    assert.match(stream.chunks.join(''), /✔ Evaluating options +0:0\d\n/);
  });

  test('Tells whether it drew anything, leaving spacing to what follows', () => {
    const stream = fakeStream(true);
    const progress = createProgress({ stream, color: false });
    assert.strictEqual(progress.stop(), false);
    progress.update({ phase: 'evaluate', detail: 'a', current: 1, total: 1 });
    assert.strictEqual(progress.stop(), true);
    assert.ok(stream.chunks.join('').endsWith(`0:00\n${ESC}[?25h`));
    assert.strictEqual(createProgress({ stream: fakeStream(false), verbose: true }).stop(), false);
  });

  test('Prints messages above the indicator', () => {
    const stream = fakeStream(true);
    const progress = createProgress({ stream, color: false });
    progress.update({ phase: 'evaluate', detail: 'a', current: 1, total: 2 });
    progress.log('Using config file html-minifier.config.json');
    progress.stop();
    assert.ok(stream.chunks.join('').includes(`${ESC}[2KUsing config file html-minifier.config.json\n`));
  });

  test('Writes nothing elsewhere but messages and, if verbose, phase changes', () => {
    const quiet = fakeStream(false);
    const progressQuiet = createProgress({ stream: quiet });
    progressQuiet.update({ phase: 'evaluate', detail: 'a', current: 1, total: 2 });
    progressQuiet.log('Note');
    progressQuiet.stop();
    assert.deepStrictEqual(quiet.chunks, ['Note\n']);

    const verbose = fakeStream(false);
    const progressVerbose = createProgress({ stream: verbose, verbose: true });
    progressVerbose.update({ phase: 'evaluate', detail: 'a', current: 1, total: 2 });
    progressVerbose.update({ phase: 'evaluate', detail: 'b', current: 2, total: 2 });
    progressVerbose.stop();
    assert.deepStrictEqual(verbose.chunks, ['Evaluating options: a\n', 'Evaluating options: b\n']);
  });
});