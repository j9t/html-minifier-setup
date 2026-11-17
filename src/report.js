import { presets as PRESETS } from 'html-minifier';
import { VISIBLE_BY_DESIGN } from './catalog.js';
import { paint } from './color.js';
import { byMetric, METRICS, NAMES_METRIC } from './measure.js';
import { MESSAGE_RENDERS_SAME } from './select.js';

const URL_SCHEMA = 'https://raw.githubusercontent.com/j9t/html-minifier/main/html-minifier.schema.json';

const MAX_LISTED = 3;

// Render differences, worded so as not to read as errors
const LABEL_RENDER = 'Looks different';

/** @param {string} level */
const labelOf = (level) => level === 'render' ? LABEL_RENDER : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;

// Share of the size below which whitespace collapsing suggests minified pages
const SHARE_MINIFIED = 0.01;

const ORDER_STATUS = ['kept', 'accepted', 'rejected', 'in-effect', 'no-gain', 'no-effect', 'skipped'];

// Statuses in words, so as not to read as verdicts on options
/** @type {Record<string, string>} */
const LABELS_STATUS = { 'accepted': 'recommended', 'kept': 'kept', 'rejected': 'doesn’t fit', 'in-effect': 'in effect already', 'no-gain': 'no gain', 'no-effect': 'no effect', 'skipped': 'skipped' };

/** @param {string} status */
const formatStatus = (status) => LABELS_STATUS[status] ?? status;

/**
 * The result as an HTML Minifier configuration, sorted by option name
 * @param {import('./select.js').Result} result
 * @param {Record<string, unknown>} [preserved] CLI settings to keep (e.g., `fileExt`)
 * @returns {Record<string, unknown>}
 */
export function toConfig(result, preserved = {}) {
  return {
    $schema: URL_SCHEMA,
    ...Object.fromEntries(Object.entries({ ...preserved, ...result.options }).sort(([a], [b]) => a.localeCompare(b)))
  };
}

/**
 * Whether any option is recommended or kept, not counting carried options
 * @param {import('./select.js').Result} result
 */
export const hasRecommendation = (result) => result.evaluations.some((evaluation) => evaluation.status === 'accepted' || evaluation.status === 'kept');

/** @param {import('./select.js').Result} result */
const inEffect = (result) => result.evaluations.filter((evaluation) => evaluation.status === 'in-effect').sort((a, b) => a.name.localeCompare(b.name));

/**
 * The result with the options in effect already, as configuration matching the pages, if any
 * are and none that save something were rejected, as it would then read as an alternative
 * @param {import('./select.js').Result} result
 * @param {Record<string, unknown>} [preserved]
 * @returns {Record<string, unknown> | null}
 */
export function toMatchingConfig(result, preserved = {}) {
  const found = inEffect(result);
  return found.length && !result.evaluations.some((evaluation) => evaluation.status === 'rejected') ? toConfig({ ...result, options: Object.assign({}, result.options, ...found.map((evaluation) => evaluation.options)) }, preserved) : null;
}

/**
 * Whether the pages look minified already, by whitespace collapsing saving next to nothing, as
 * unminified pages have whitespace to collapse
 * @param {import('./select.js').Result} result
 */
function looksMinified(result) {
  const whitespace = result.evaluations.find((evaluation) => evaluation.name === 'collapseWhitespace');
  return Boolean(whitespace && whitespace.status !== 'skipped' && whitespace.savings < result.baseline[result.metric] * SHARE_MINIFIED);
}

/**
 * How far a rejected option moves elements at most, where that is all it was rejected for
 * @param {import('./select.js').Evaluation} evaluation
 * @returns {number | null}
 */
function shiftOnly(evaluation) {
  if (evaluation.status !== 'rejected') return null;
  const blocking = evaluation.reasons.filter((reason) => reason.level !== 'info' && reason.level !== 'check' && reason.level !== 'note');
  if (!blocking.length || !blocking.every((reason) => reason.level === 'render' && typeof reason.shift === 'number')) return null;
  return Math.max(...blocking.map((reason) => /** @type {number} */ (reason.shift)));
}

/** @param {string[]} items */
const listAnd = (items) => items.length > 2 ? `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}` : items.join(' and ');

/**
 * The recommended configuration, or why there’s none, with the options in effect already
 * @param {import('./select.js').Result} result
 * @param {{preserved?: Record<string, unknown>, color?: boolean}} [settings]
 * @returns {string}
 */
export function formatConfiguration(result, { preserved = {}, color = false } = {}) {
  /** @param {Record<string, unknown>} config */
  const json = (config) => JSON.stringify(config, null, 2);
  const found = inEffect(result);
  if (hasRecommendation(result)) {
    const recommended = `${paint('bold', 'Recommended configuration:', color)}\n${json(toConfig(result, preserved))}`;
    if (!found.length) return recommended;
    const [them, verb] = found.length === 1 ? ['it', 'has'] : ['them', 'have'];
    return `${recommended}\n\nThese pages ${verb} ${listAnd(found.map(({ name }) => `\`${name}\``))} in effect already. To keep ${them} so (e.g., when switching from another minifier), add ${them}—as ${found.length === 1 ? 'it changes' : 'they change'} nothing here, the checks can’t vouch for ${them}, so check ${them} on pages before minification.`;
  }
  const rejected = result.evaluations.filter((evaluation) => evaluation.status === 'rejected');
  const shifts = rejected.map(shiftOnly);
  const shift = rejected.length && shifts.every((value) => value !== null) ? Math.max(.../** @type {number[]} */ (shifts)) : null;
  const reason = looksMinified(result)
    ? 'These pages look minified already.'
    : shift !== null
      ? `The options that save something only move elements on these pages, by up to ${shift} px—\`--allow-shift ${shift}\` accepts that.`
      : rejected.length
        ? 'The options that save something don’t fit these pages.'
        : `No option saves anything on these pages ${byMetric(result.metric)}.`;
  const lines = [`No configuration to recommend: ${reason}`];
  const matching = toMatchingConfig(result, preserved);
  if (matching) lines.push('', `${paint('bold', 'Configuration matching these pages, by the options in effect already', color)} (as they change nothing here, the checks can’t vouch for them—check it on pages before minification):`, json(matching));
  return lines.join('\n');
}

/**
 * The configuration as the HTML Minifier preset needing the fewest changes to have the same
 * effect, if that at least halves the options to list
 * @param {import('./select.js').Result} result
 * @param {Record<string, unknown>} [preserved]
 * @returns {{name: string, changes: string[], config: Record<string, unknown>} | null}
 */
export function toPresetConfig(result, preserved = {}) {
  const { options } = result;
  const [nearest] = Object.entries(PRESETS).map(([name, preset]) => {
    /** @type {Record<string, unknown>} */
    const presetOptions = preset;
    /** @type {Record<string, unknown>} */
    const overrides = {};
    for (const key of new Set([...Object.keys(presetOptions), ...Object.keys(options)])) {
      const value = key in options ? options[key] : false;
      if (JSON.stringify(value) !== JSON.stringify(presetOptions[key] ?? false)) overrides[key] = value;
    }
    return { name, overrides };
  }).sort((a, b) => Object.keys(a.overrides).length - Object.keys(b.overrides).length);
  if (!nearest || Object.keys(nearest.overrides).length * 2 > Object.keys(options).length) return null;
  const { $schema, ...rest } = toConfig({ ...result, options: nearest.overrides }, preserved);
  return { name: nearest.name, changes: Object.keys(nearest.overrides).sort(), config: { $schema, preset: nearest.name, ...rest } };
}

/** @param {number} bytes */
const formatBytes = (bytes) => `${bytes.toLocaleString('en-US')} B`;

/**
 * @param {number} before
 * @param {number} after
 * @param {boolean} color
 */
const formatChange = (before, after, color) => {
  const share = before ? Math.abs(1 - after / before) * 100 : 0;
  const change = after === before || !share
    ? paint('dim', '±0%', color)
    : paint(after < before ? 'success' : 'failure', `${after < before ? '−' : '+'}${share.toFixed(1)}%`, color);
  return `${formatBytes(before)} → ${formatBytes(after)} (${change})`;
};

/**
 * The directory all pages are in, with a trailing slash, if any
 * @param {string[]} pages
 */
function sharedDir(pages) {
  const [first = [], ...rest] = pages.map((page) => page.split('/').slice(0, -1));
  let length = 0;
  while (length < first.length && rest.every((segments) => segments[length] === first[length])) length++;
  return length ? `${first.slice(0, length).join('/')}/` : '';
}

/** @param {string[]} items */
const listShort = (items) => items.length > MAX_LISTED
  ? `${items.slice(0, MAX_LISTED).join(', ')}, and ${items.length - MAX_LISTED} more`
  : items.join(', ');

/**
 * Reasons as lines, summing up render differences by pages (with an example) and other reasons
 * by message
 * @param {import('./select.js').Reason[]} reasons
 * @returns {string[]}
 */
function condenseReasons(reasons) {
  /** @type {string[]} */
  const lines = [];
  let pagesRenderedBefore = '';
  for (let index = 0; index < reasons.length;) {
    const level = /** @type {import('./select.js').Reason} */ (reasons[index]).level;
    // Reasons of a kind in a row: render differences, info, or anything else
    const kind = level === 'render' || level === 'info' ? level : 'other';
    /** @type {import('./select.js').Reason[]} */
    const run = [];
    for (let next = reasons[index]; next && (next.level === 'render' || next.level === 'info' ? next.level : 'other') === kind; next = reasons[++index]) run.push(next);

    if (kind === 'render') {
      const pages = [...new Set(run.flatMap((reason) => reason.page ?? []))];
      const count = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
      if (pages.join('\u0000') === pagesRenderedBefore) {
        lines.push(`${LABEL_RENDER} on the same ${count}`);
      } else {
        // The largest move, matching what `--allow-shift` would need, or else changed text
        const [moveLargest] = run.filter((reason) => typeof reason.shift === 'number').sort((a, b) => /** @type {number} */ (b.shift) - /** @type {number} */ (a.shift));
        const example = /** @type {import('./select.js').Reason} */ (moveLargest ?? run.find((reason) => reason.message.includes('“')) ?? run[0]);
        lines.push(`${LABEL_RENDER} on ${count} (${listShort(pages)}), e.g., ${example.page ? `${example.page}: ` : ''}${example.message}`);
      }
      pagesRenderedBefore = pages.join('\u0000');
      continue;
    }
    /** @type {Map<string, {level: string, message: string, pages: string[]}>} */
    const byMessage = new Map();
    for (const reason of run) {
      const key = `${reason.level}\u0000${reason.message}`;
      const entry = byMessage.get(key) ?? { level: reason.level, message: reason.message, pages: [] };
      if (reason.page) entry.pages.push(reason.page);
      byMessage.set(key, entry);
    }
    for (const { level: levelEntry, message, pages } of byMessage.values()) {
      lines.push(`${labelOf(levelEntry)}${pages.length ? ` (${listShort(pages)})` : ''}: ${message}`);
    }
  }
  return lines;
}

/**
 * @param {string[][]} rows
 */
function table(rows) {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows.map((row) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()).join('\n');
}

/**
 * @param {import('./select.js').Result} result
 * @param {{renderReason?: string, color?: boolean, verbose?: boolean}} [settings]
 * @returns {string}
 */
export function formatReport(result, { renderReason = '', color = false, verbose = false } = {}) {
  const { blocked = [], failed = [], allowShift = 0 } = result;
  const { metric } = result;
  const dirShared = sharedDir(result.pages);
  const evaluations = result.evaluations.map((evaluation) => ({
    ...evaluation,
    reasons: evaluation.reasons.map((reason) => reason.page?.startsWith(dirShared) ? { ...reason, page: reason.page.slice(dirShared.length) } : reason)
      .map((reason) => blocked.length && reason.message === MESSAGE_RENDERS_SAME ? { ...reason, message: `${reason.message}, but without files outside the site` } : reason)
  })).sort((a, b) =>
    ORDER_STATUS.indexOf(a.status) - ORDER_STATUS.indexOf(b.status) ||
    (b.contribution ?? b.savings) - (a.contribution ?? a.savings) ||
    a.name.localeCompare(b.name));

  const renderedAs = `Render-checked in ${result.browser ?? 'Chromium'}${result.viewports.length ? ` at ${result.viewports.join(' and ')}` : ''}${allowShift ? `, allowing elements to move by up to ${allowShift} px` : ''}`;
  const renderSummary = blocked.length
    ? paint('warning', `${renderedAs}: The recommended configuration may not look the same as the original pages, as files outside the site were missing`, color)
    : failed.length
      ? paint('warning', `${renderedAs}: The recommended configuration may not look the same as the original pages, as files didn’t load`, color)
      : result.renderedSame
        ? `${renderedAs}: The recommended configuration looks the same as the original pages`
        : paint('warning', `${renderedAs}: The recommended configuration may not look the same as the original pages (see notes)`, color);
  const lines = [
    `• Evaluated ${result.pagesFound ? `${result.pages.length} of ${result.pagesFound.toLocaleString('en-US')} pages` : `${result.pages.length} page${result.pages.length === 1 ? '' : 's'}`}${dirShared ? ` in ${dirShared}` : ''}${result.pagesFound ? ' (use `--sample` to evaluate more)' : ''}, judging gains by ${NAMES_METRIC[metric]} size`,
    result.rendered
      ? `• ${renderSummary}`
      : `• Not render-checked${renderReason ? `: ${renderReason}` : ''}—options that need a render check aren’t recommended`,
    ...result.rendered && blocked.length ? [`• ${paint('warning', `Rendered without ${blocked.length} file${blocked.length === 1 ? '' : 's'} that symbolic links lead to outside the site (${listShort(blocked)}), which may change how pages look—\`--follow-links\` follows them`, color)}`] : [],
    ...result.rendered && failed.length ? [`• ${paint('warning', `Rendered without ${failed.length} file${failed.length === 1 ? '' : 's'} that didn’t load (${listShort(failed)}), which may change how pages look`, color)}`] : [],
    // Only in development
    ...result.equivalence ? [`• Equivalence-checked with ${result.equivalence}`] : [],
    '',
    table([
      ['Option', 'Status', 'Saves alone', 'Contributes', 'Variant'],
      ...evaluations.map((evaluation) => [
        evaluation.name,
        formatStatus(evaluation.status),
        evaluation.status === 'skipped' ? '' : formatBytes(evaluation.savings),
        evaluation.contribution === undefined ? '' : formatBytes(evaluation.contribution),
        evaluation.variant ?? ''
      ])
    ]),
    '',
    ...METRICS.map((m) => `${m === 'raw' ? 'Uncompressed' : NAMES_METRIC[m]}: ${formatChange(result.baseline[m], result.final[m], color)}`)
  ];

  if (result.presets.length) {
    const finalMetric = result.final[metric];
    lines.push('', `Compared with HTML Minifier’s presets (${NAMES_METRIC[metric]}):`, table(result.presets.map((preset) => {
      const share = finalMetric ? (preset.size / finalMetric - 1) * 100 : 0;
      const size = preset.errors ? `fails on ${preset.errors} of ${result.pages.length}` : formatBytes(preset.size);
      const relative = preset.errors ? '' : Math.abs(share) < 0.05 ? 'same size' : `${Math.abs(share).toFixed(1)}% ${share > 0 ? 'larger' : 'smaller'}`;
      // Over the pages the preset could minify
      const checked = result.pages.length - preset.errors;
      const ofPages = `of ${checked} page${checked === 1 ? '' : 's'}`;
      const rendering = preset.failing === null || !checked
        ? 'not render-checked'
        : preset.failing
          ? paint('failure', `looks different on ${preset.failing} ${ofPages}${preset.shift ? ` (moves elements by up to ${preset.shift} px)` : ''}${preset.inconclusive ? `, inconclusive on ${preset.inconclusive}` : ''}`, color)
          : preset.inconclusive
            ? `inconclusive on ${preset.inconclusive} ${ofPages}`
            : paint('success', preset.errors ? `looks the same on the other ${checked} page${checked === 1 ? '' : 's'}` : 'looks the same', color);
      const rejected = preset.rejected.length ? `; includes ${paint('failure', preset.rejected.map((name) => `\`${name}\``).join(', '), color)}, which ${preset.rejected.length === 1 ? 'doesn’t' : 'don’t'} fit` : '';
      return [`  ${preset.name}`, size, relative, `${rendering}${rejected}`];
    })));
  }

  // Options that change nothing can’t be judged on minified pages, as minification
  // may have done their work
  if (looksMinified(result)) {
    const evaluated = evaluations.filter((evaluation) => evaluation.status !== 'skipped');
    const ineffective = evaluated.filter((evaluation) => evaluation.status === 'no-effect' || evaluation.status === 'in-effect');
    lines.push('', `These pages look minified already: Collapsing whitespace saves less than ${SHARE_MINIFIED * 100}%, and ${ineffective.length} of ${evaluated.length} options change nothing. To evaluate those options, run on pages before minification (e.g., your build output with minification turned off).`);
  }

  const explained = evaluations.filter((evaluation) => evaluation.status !== 'in-effect' && evaluation.reasons.some((reason) => reason.level !== 'info' || (evaluation.status !== 'no-gain' && evaluation.status !== 'no-effect')));
  if (explained.length) {
    lines.push('', 'Details:');
    let condensed = false;
    // Options with the same details are listed once, together, as where one cause affects several
    /** @type {Map<string, {names: string[], status: string, body: string[]}>} */
    const groups = new Map();
    for (const evaluation of explained) {
      /** @type {string[]} */
      const body = [];
      const reasonLines = verbose
        ? evaluation.reasons.map((reason) => `${labelOf(reason.level)}${reason.page ? ` (${reason.page})` : ''}: ${reason.message}`)
        : condenseReasons(evaluation.reasons);
      condensed ||= reasonLines.length < evaluation.reasons.length;
      if (evaluation.reasons.some((reason) => reason.level === 'render')) {
        const design = VISIBLE_BY_DESIGN[evaluation.name];
        body.push(`    Why: ${design ? `${design}—that’s how the option works, not an error` : 'Not meant to change how pages look—possibly an HTML Minifier bug worth reporting'}`);
        const shift = shiftOnly(evaluation);
        if (shift !== null) body.push(`    Only moves elements, by up to ${shift} px—\`--allow-shift ${shift}\` accepts that`);
      }
      body.push(...reasonLines.map((line) => `    ${line}`));
      const key = `${evaluation.status}\u0000${body.join('\n')}`;
      const group = groups.get(key);
      if (group) {
        group.names.push(evaluation.name);
      } else {
        groups.set(key, { names: [evaluation.name], status: evaluation.status, body });
      }
    }
    for (const { names, status, body } of groups.values()) lines.push(`  ${names.join(', ')} (${formatStatus(status)})`, ...body);
    if (condensed) lines.push('  (Run with `-v` for every page and viewport)');
  }
  if (result.notes.length) {
    lines.push('', 'Notes:', ...result.notes.map((note) => `• ${note}`));
  }
  lines.push('', `Checks can show that options change these pages, not that they never will${hasRecommendation(result) ? '—test the configuration on your site' : ''}.`);
  return lines.join('\n');
}