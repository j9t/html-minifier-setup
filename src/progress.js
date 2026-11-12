// A one-line progress indicator: animated on terminals, and otherwise quiet (or, if verbose, line
// by line)

import { CSI, ESC, paint, supportsColor } from './color.js';

/**
 * @typedef {object} ProgressEvent
 * @prop {'read' | 'start' | 'evaluate' | 'render' | 'contribute' | 'presets'} phase
 * @prop {string} [detail] What is being worked on
 * @prop {number} [current] Steps done in the phase
 * @prop {number} [total] Steps in the phase, if known
 */

/**
 * @typedef {object} Progress
 * @prop {(event: ProgressEvent) => void} update
 * @prop {(message: string) => void} log Prints a message above the indicator
 * @prop {(settings?: {ok?: boolean}) => boolean} stop Returns whether the indicator was drawn
 */

const RE_ANSI = new RegExp(`${ESC}\\[[\\d;?]*[A-Za-z]`, 'g');
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const WIDTH_BAR = 24;
const INTERVAL = 80;

/** @type {Record<ProgressEvent['phase'], string>} */
export const TITLES = {
  read: 'Reading pages',
  start: 'Starting browser',
  evaluate: 'Evaluating options',
  render: 'Rendering',
  contribute: 'Measuring contributions',
  presets: 'Comparing presets'
};

/** @param {string} text */
export const visibleLength = (text) => [...text.replace(RE_ANSI, '')].length;

/** @param {number} ms */
const formatElapsed = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * @param {string} text
 * @param {number} width
 */
const truncate = (text, width) => {
  const chars = [...text];
  if (width <= 0) return '';
  return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join('')}…` : text;
};

/**
 * One frame of the indicator, fit to the terminal width
 * @param {{title: string, detail: string, current?: number, total?: number, elapsed: number, frame: number, columns: number, color: boolean}} state
 * @returns {string}
 */
export function formatLine({ title, detail, current = 0, total, elapsed, frame, columns, color }) {
  const spinner = paint('accent', FRAMES[frame % FRAMES.length] ?? '', color);
  const head = `${spinner} ${paint('bold', title, color)}`;
  const time = paint('dim', formatElapsed(elapsed), color);
  /** @type {string[]} */
  const parts = [head];
  if (total) {
    const ratio = Math.min(1, Math.max(0, current / total));
    const filled = Math.round(ratio * WIDTH_BAR);
    // Without color, the rest of the bar needs a lighter line to show
    const bar = paint('accent', '━'.repeat(filled), color) + paint('dim', (color ? '━' : '─').repeat(WIDTH_BAR - filled), color);
    parts.push(`${bar} ${`${Math.floor(ratio * 100)}%`.padStart(4)}`);
  }
  parts.push(time);
  const budget = columns - 1;
  // Where even without a detail the line is too long, the bar goes first
  if (visibleLength(parts.join('  ')) > budget && parts.length > 2) parts.splice(1, 1);
  const room = budget - visibleLength(parts.join('  ')) - 2;
  if (detail && room > 3) parts.push(truncate(detail, room));
  return parts.join('  ');
}

/**
 * @param {{stream?: {isTTY?: boolean, columns?: number, write: (chunk: string) => unknown}, color?: boolean, verbose?: boolean}} [settings]
 * @returns {Progress}
 */
export function createProgress({ stream = process.stderr, color, verbose = false } = {}) {
  const animated = Boolean(stream.isTTY);
  const colored = color ?? supportsColor(stream);
  /** @type {(ProgressEvent & {start: number}) | null} */
  let state = null;
  let frame = 0;
  let lastDraw = 0;
  let lastLine = '';
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  const showCursor = () => stream.write(`${CSI}?25h`);
  const onInterrupt = () => {
    stream.write(`\r${CSI}2K`);
    showCursor();
    process.exit(130);
  };

  const draw = () => {
    if (!state) return;
    lastDraw = Date.now();
    frame++;
    stream.write(`\r${CSI}2K${formatLine({
      title: TITLES[state.phase],
      detail: state.detail ?? '',
      current: state.current ?? 0,
      ...(state.total ? { total: state.total } : {}),
      elapsed: Date.now() - state.start,
      frame,
      columns: stream.columns || 80,
      color: colored
    })}`);
  };

  /** @param {boolean} ok */
  const finish = (ok) => {
    if (!state || !animated) return;
    const mark = ok ? paint('success', '✔', colored) : paint('failure', '✖', colored);
    stream.write(`\r${CSI}2K${mark} ${TITLES[state.phase]}  ${paint('dim', formatElapsed(Date.now() - state.start), colored)}\n`);
  };

  return {
    update(event) {
      if (state && state.phase !== event.phase) finish(true);
      state = { ...event, start: state && state.phase === event.phase ? state.start : Date.now() };
      if (!animated) {
        const line = `${TITLES[event.phase]}${event.detail ? `: ${event.detail}` : ''}`;
        if (verbose && line !== lastLine) stream.write(`${line}\n`);
        lastLine = line;
        return;
      }
      if (!timer) {
        stream.write(`${CSI}?25l`);
        process.once('SIGINT', onInterrupt);
        timer = setInterval(draw, INTERVAL);
        timer.unref();
      }
      // Drawn on updates, too, as long stretches of minification leave the timer no turn
      if (Date.now() - lastDraw >= INTERVAL) draw();
    },
    log(message) {
      stream.write(animated ? `\r${CSI}2K${message}\n` : `${message}\n`);
      if (animated) draw();
    },
    stop({ ok = true } = {}) {
      finish(ok);
      state = null;
      if (!timer) return false;
      clearInterval(timer);
      timer = null;
      process.removeListener('SIGINT', onInterrupt);
      showCursor();
      return true;
    }
  };
}