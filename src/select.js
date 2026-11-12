// Finds the options that save the most on the given pages without changing them: Each candidate
// is measured and checked on its own, then the accepted ones are rendered together, isolating
// options that break rendering on their own or only in combination

import { minify as minifyHM, presets as PRESETS } from 'html-minifier';
import { CANDIDATES, FALLBACKS, readSchema, unclassified } from './catalog.js';
import { analyzePage, findHazards } from './hazards.js';
import { sizeOf, sumSizes } from './measure.js';

/**
 * @typedef {object} Reason
 * @prop {'risk' | 'check' | 'note' | 'render' | 'equivalence' | 'error' | 'info'} level
 * @prop {string} message
 * @prop {string} [page]
 */

/**
 * @typedef {object} Evaluation
 * @prop {string} name
 * @prop {Record<string, unknown>} options
 * @prop {'accepted' | 'kept' | 'rejected' | 'no-gain' | 'no-effect' | 'skipped'} status
 * @prop {string} [variant] Fallback in use, if any
 * @prop {number} savings Bytes saved on its own (on top of what it requires, or with it where that saves nothing alone), by the metric
 * @prop {number} [contribution] Bytes the final configuration would lose without it, by the metric
 * @prop {Reason[]} reasons
 */

/**
 * @typedef {object} Result
 * @prop {import('./measure.js').Metric} metric
 * @prop {Record<string, unknown>} options Configuration found, including carried options
 * @prop {import('./measure.js').Sizes} baseline
 * @prop {import('./measure.js').Sizes} final
 * @prop {Evaluation[]} evaluations
 * @prop {string[]} pages
 * @prop {boolean} rendered
 * @prop {string | null} equivalence Source of the equivalence check, if used
 * @prop {string[]} notes
 * @prop {PresetComparison[]} presets
 * @prop {boolean} renderedSame Whether the configuration was found to look the same as the original pages
 * @prop {string[]} viewports Viewports rendered at, if known
 * @prop {string | null} browser Browser rendered in, if known
 */

/**
 * @typedef {object} PresetComparison
 * @prop {string} name
 * @prop {number} size Over the pages the preset could minify, by the metric
 * @prop {number | null} failing Pages rendering differently, if render-checked
 * @prop {number} errors Pages the preset couldn’t minify
 * @prop {string[]} rejected Options the preset includes that were rejected
 */

/**
 * @typedef {object} Settings
 * @prop {Record<string, unknown>} [base] Options carried into every run
 * @prop {Record<string, unknown>} [values] Candidate values to evaluate instead of `true`
 * @prop {import('./measure.js').Metric} [metric]
 * @prop {string[]} [keep] Candidates to accept regardless of risks and gains
 * @prop {string[]} [skip] Candidates not to evaluate
 * @prop {import('./render.js').Renderer | null} [renderer]
 * @prop {import('./equivalence.js').Equivalence | null} [equivalence]
 * @prop {(html: string, options: Record<string, unknown>) => Promise<string>} [minify]
 * @prop {boolean} [presets] Whether to compare the result with HTML Minifier’s presets
 * @prop {{version: string, options: string[]} | null} [schema] HTML Minifier’s options, by default the installed version’s
 * @prop {(event: import('./progress.js').ProgressEvent) => void} [onProgress]
 */

const MAX_RENDER_ROUNDS = 12;
const MAX_REASONS_PER_PAGE = 2;
const MESSAGE_RENDERS_SAME = 'Looks the same where checks were needed';

// Lets timers run, such as a progress indicator’s, between stretches of synchronous work
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

/** @param {unknown} value */
const stableKey = (value) => JSON.stringify(value, (_, inner) => inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
  : inner instanceof RegExp || typeof inner === 'function' ? String(inner) : inner);

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';

/**
 * @param {import('./pages.js').Page[]} pagesGiven
 * @param {Settings} [settings]
 * @returns {Promise<Result>}
 */
export async function customize(pagesGiven, settings = {}) {
  const {
    base = {},
    values = {},
    metric = 'gzip',
    keep = [],
    skip = [],
    renderer = null,
    equivalence = null,
    minify = minifyHM,
    presets = true,
    schema = readSchema(),
    onProgress = () => {}
  } = settings;

  const names = CANDIDATES.map((candidate) => candidate.name);
  for (const name of [...keep, ...skip]) {
    if (!names.includes(name)) throw new Error(`Unknown option: ${name} (options that can be kept or skipped: ${names.join(', ')})`);
  }

  // By page rather than by ID, as pages from different roots may share one
  /** @type {Map<import('./pages.js').Page, Map<string, Promise<string>>>} */
  const outputs = new Map();
  /**
   * @param {import('./pages.js').Page} page
   * @param {Record<string, unknown>} options
   */
  const run = (page, options) => {
    const byOptions = outputs.get(page) ?? new Map();
    outputs.set(page, byOptions);
    const key = stableKey(options);
    let output = byOptions.get(key);
    if (!output) {
      output = minify(page.html, { ...options, log: () => {} });
      byOptions.set(key, output);
    }
    return output;
  };

  // Measured by the metric alone but for baseline and final sizes, as compression takes its time
  /** @type {Map<import('./measure.js').Metric, Map<string, Promise<number>>>} */
  const sizes = new Map();
  /**
   * @param {string} text
   * @param {import('./measure.js').Metric} [by]
   */
  const sizeCached = (text, by = metric) => {
    const cache = sizes.get(by) ?? new Map();
    sizes.set(by, cache);
    let size = cache.get(text);
    if (!size) {
      size = sizeOf(text, by);
      cache.set(text, size);
    }
    return size;
  };
  /** @param {string[]} texts */
  const totalSize = async (texts) => (await Promise.all(texts.map((text) => sizeCached(text)))).reduce((sum, size) => sum + size, 0);
  /** @param {Record<string, unknown>} options */
  const totalOf = async (options) => totalSize(await Promise.all(pages.map((page) => run(page, options))));
  /** @param {Record<string, unknown>} options */
  const sizesOf = async (options) => sumSizes(await Promise.all(pages.map(async (page) => {
    const text = await run(page, options);
    const [raw, gzip, brotli] = await Promise.all([sizeCached(text, 'raw'), sizeCached(text, 'gzip'), sizeCached(text, 'brotli')]);
    return { raw, gzip, brotli };
  })));

  /** @type {Set<string>} */
  const notes = new Set();
  const optionsNew = unclassified(schema?.options ?? []);
  if (optionsNew.length) notes.add(`HTML Minifier ${schema?.version} has options this version of HTML Minifier Setup doesn’t evaluate yet: ${optionsNew.join(', ')}`);

  // Pages the minifier can’t read with the carried options are left out
  /** @type {import('./pages.js').Page[]} */
  const pages = [];
  for (const page of pagesGiven) {
    try {
      await run(page, base);
      pages.push(page);
    } catch (err) {
      notes.add(`Left out ${page.id}, which the minifier can’t read: ${messageOf(err)}`);
    }
  }
  if (!pages.length) throw new Error(`The minifier can read none of the pages (${[...notes].join('; ')})—\`continueOnParseError\` in a starting configuration may help`);

  const contexts = new Map(await Promise.all(pages.map(async (page) => /** @type {const} */ ([page, await analyzePage(page)]))));

  /** @type {Map<string, Evaluation>} */
  const evaluations = new Map();
  /** @type {Map<string, number>} */
  const variantIndex = new Map();
  let renderLimitReached = false;
  // Pages whose last render of the options in use was inconclusive
  /** @type {Set<string>} */
  let pagesUnchecked = new Set();

  /** @param {string} name */
  const requirementOf = (name) => CANDIDATES.find((candidate) => candidate.name === name)?.requires;
  /** @param {Evaluation | undefined} evaluation */
  const isInUse = (evaluation) => evaluation?.status === 'accepted' || evaluation?.status === 'kept';
  // Requirements not in use are part of their dependents’ options instead
  /** @param {string} name */
  const contextOptions = (name) => {
    const requirement = evaluations.get(requirementOf(name) ?? '');
    return { ...base, ...(isInUse(requirement) ? requirement?.options : {}) };
  };
  /** @param {Evaluation[]} list */
  const combine = (list) => Object.assign({}, base, ...list.map((evaluation) => evaluation.options));
  const inUse = () => [...evaluations.values()].filter(isInUse);
  /** @param {Reason[]} reasons */
  const isBlocking = (reasons) => reasons.some((reason) => reason.level === 'risk' || reason.level === 'equivalence' || reason.level === 'error' || (reason.level === 'check' && !renderer));

  /**
   * Measures and checks a candidate without rendering
   * @param {string} name
   * @param {Record<string, unknown>} options
   * @param {(index: number, page: import('./pages.js').Page) => Promise<void>} [onPage]
   * @returns {Promise<Omit<Evaluation, 'name' | 'options'>>}
   */
  async function evaluateStatic(name, options, onPage = async () => {}) {
    const ctx = contextOptions(name);
    const full = { ...ctx, ...options };
    /** @type {Reason[]} */
    const reasons = [];
    let changed = false;
    let savings = 0;
    for (const [index, page] of pages.entries()) {
      await onPage(index, page);
      let outBefore;
      let outAfter;
      try {
        outBefore = await run(page, ctx);
        outAfter = await run(page, full);
      } catch (err) {
        reasons.push({ level: 'error', page: page.id, message: `Minification failed: ${messageOf(err)}` });
        continue;
      }
      const [sizeBefore, sizeAfter] = await Promise.all([sizeCached(outBefore), sizeCached(outAfter)]);
      savings += sizeBefore - sizeAfter;
      if (outBefore === outAfter) continue;
      changed = true;
      const context = /** @type {import('./hazards.js').PageContext} */ (contexts.get(page));
      for (const hazard of findHazards(name, context, outBefore, outAfter)) reasons.push({ ...hazard, page: page.id });
      if (equivalence?.supports(name)) {
        try {
          const [difference] = equivalence.compare(page.html, outAfter, full);
          if (difference) reasons.push({ level: 'equivalence', page: page.id, message: `Output differs from the source, likely an HTML Minifier bug worth reporting (${difference})` });
        } catch (err) {
          notes.add(`Equivalence check failed on ${page.id}: ${messageOf(err)}`);
        }
      }
    }

    if (reasons.some((reason) => reason.level === 'error')) return { status: 'rejected', savings, reasons };
    if (keep.includes(name)) return { status: 'kept', savings, reasons };
    if (!changed) return { status: 'no-effect', savings, reasons: [{ level: 'info', message: 'No effect on these pages' }] };
    if (savings <= 0) return { status: 'no-gain', savings, reasons: [{ level: 'info', message: `Saves nothing ${metric === 'raw' ? 'uncompressed' : `with ${metric}`}` }, ...reasons] };
    return { status: isBlocking(reasons) ? 'rejected' : 'accepted', savings, reasons };
  }

  /**
   * Moves a candidate to its next fallback, or rejects it
   * @param {Evaluation} evaluation
   * @param {Reason[]} reasons
   */
  async function demote(evaluation, reasons) {
    const variants = FALLBACKS[evaluation.name] ?? [];
    evaluation.reasons.push(...reasons);
    for (let index = (variantIndex.get(evaluation.name) ?? -1) + 1; index < variants.length; index++) {
      const { variant, options } = /** @type {{variant: string, options: Record<string, unknown>}} */ (variants[index]);
      const outcome = await evaluateStatic(evaluation.name, options);
      variantIndex.set(evaluation.name, index);
      if (outcome.status === 'accepted') {
        Object.assign(evaluation, { options, variant, savings: outcome.savings, status: 'accepted' });
        const known = new Set(evaluation.reasons.map((reason) => `${reason.level}${reason.page}${reason.message}`));
        evaluation.reasons.push({ level: 'info', message: `Falls back to \`${variant}\`` }, ...outcome.reasons.filter((reason) => !known.has(`${reason.level}${reason.page}${reason.message}`)));
        return;
      }
      evaluation.reasons.push({ level: 'info', message: `Fallback \`${variant}\` ${outcome.status === 'no-gain' || outcome.status === 'no-effect' ? 'saves nothing' : 'doesn’t fit, either'}` });
    }
    evaluation.status = 'rejected';
    dropDependents(evaluation);
  }

  /**
   * Takes what requires an evaluation that is no longer in use out of use, too
   * @param {Evaluation} evaluation
   */
  function dropDependents(evaluation) {
    for (const dependent of evaluations.values()) {
      if (requirementOf(dependent.name) === evaluation.name && isInUse(dependent)) {
        dependent.status = evaluation.status;
        delete dependent.contribution;
        dependent.reasons.push({ level: 'info', message: `Needs \`${evaluation.name}\`, which is no longer in use` });
      }
    }
  }

  // 1. Each candidate on its own
  for (const [index, candidate] of CANDIDATES.entries()) {
    const total = CANDIDATES.length * pages.length;
    onProgress({ phase: 'evaluate', detail: candidate.name, current: index * pages.length, total });
    const own = candidate.name in values ? { [candidate.name]: values[candidate.name] } : candidate.options;
    const requirement = candidate.requires ? evaluations.get(candidate.requires) : undefined;
    // A requirement that is safe but saves nothing alone may still pay off along with what needs it
    const paired = requirement && (requirement.status === 'no-gain' || requirement.status === 'no-effect') && !isBlocking(requirement.reasons);
    const options = paired ? { ...requirement.options, ...own } : own;
    /** @type {Evaluation} */
    const evaluation = { name: candidate.name, options, status: 'skipped', savings: 0, reasons: [] };
    evaluations.set(candidate.name, evaluation);
    if (skip.includes(candidate.name)) {
      evaluation.reasons.push({ level: 'info', message: 'Skipped as asked' });
    } else if (requirement && !isInUse(requirement) && !paired) {
      evaluation.reasons.push({ level: 'info', message: `Not evaluated, as it needs \`${requirement.name}\`, which ${requirement.status === 'skipped' ? 'was skipped' : 'doesn’t fit'}` });
    } else {
      Object.assign(evaluation, await evaluateStatic(candidate.name, options, async (step, page) => {
        onProgress({ phase: 'evaluate', detail: `${candidate.name} · ${page.id}`, current: index * pages.length + step, total });
        await yieldTurn();
      }));
      if (paired && (evaluation.status === 'accepted' || evaluation.status === 'kept')) {
        evaluation.reasons.unshift({ level: 'info', message: `Brings in \`${requirement.name}\`, which saves nothing alone` });
      }
      if (evaluation.status === 'rejected' && FALLBACKS[candidate.name]) {
        const reasons = evaluation.reasons;
        evaluation.reasons = [];
        await demote(evaluation, reasons);
      }
    }
  }

  /**
   * Renders all options in use together, isolating those that break rendering on their own or
   * only in combination, until rendering holds
   */
  async function settleRendering() {
    if (!renderer) return;
    /**
     * @param {import('./pages.js').Page[]} subset
     * @param {Record<string, unknown>} options
     * @param {{detail: string, counter?: {done: number}, total?: number}} step Where this is in the current stage, whose renders `counter` counts
     * @returns {Promise<{failures: {page: import('./pages.js').Page, verdict: import('./render.js').Verdict}[], inconclusive: Set<string>}>}
     */
    const failingPages = async (subset, options, { detail, counter = { done: 0 }, total = subset.length }) => {
      onProgress({ phase: 'render', detail, current: counter.done, total });
      // All at once, as the renderer limits how many render
      const verdicts = await Promise.all(subset.map(async (page) => {
        const verdict = await renderer.compare(page, await run(page, options));
        for (const note of verdict.notes) notes.add(`${page.id}: ${note}`);
        onProgress({ phase: 'render', detail, current: ++counter.done, total });
        return { page, verdict };
      }));
      return {
        failures: verdicts.filter(({ verdict }) => !verdict.equal && !verdict.inconclusive),
        inconclusive: new Set(verdicts.filter(({ verdict }) => verdict.inconclusive).map(({ page }) => page.id))
      };
    };
    /** @param {{page: import('./pages.js').Page, verdict: import('./render.js').Verdict}[]} failures */
    const renderReasons = (failures) => failures.flatMap(({ page, verdict }) => verdict.reasons.slice(0, MAX_REASONS_PER_PAGE).map((message) => /** @type {Reason} */ ({ level: 'render', page: page.id, message })));

    let round = 0;
    for (; round < MAX_RENDER_ROUNDS; round++) {
      const { failures, inconclusive } = await failingPages(pages, combine(inUse()), { detail: `${inUse().length} options together${round ? ` (round ${round + 1})` : ''}` });
      pagesUnchecked = inconclusive;
      if (!failures.length) break;
      const subset = failures.map(({ page }) => page);
      const testable = inUse().filter((evaluation) => evaluation.status === 'accepted');

      const alone = { detail: `${testable.length} options alone`, counter: { done: 0 }, total: testable.length * subset.length };
      const owns = await Promise.all(testable.map((evaluation) => failingPages(subset, { ...contextOptions(evaluation.name), ...evaluation.options }, alone)));
      /** @type {[Evaluation, Reason[]][]} */
      const culprits = testable.flatMap((evaluation, index) => {
        const own = owns[index]?.failures ?? [];
        return own.length ? [/** @type {[Evaluation, Reason[]]} */ ([evaluation, renderReasons(own)])] : [];
      });
      for (const [evaluation, reasons] of culprits) await demote(evaluation, reasons);
      if (culprits.length) continue;

      // Options that only break rendering together: Keep those saving most while rendering holds,
      // which depends on order
      const kept = inUse().filter((evaluation) => evaluation.status === 'kept');
      /** @type {Evaluation[]} */
      const together = [];
      const counter = { done: 0 };
      for (const evaluation of testable.sort((a, b) => b.savings - a.savings)) {
        const requirement = requirementOf(evaluation.name);
        const { failures: own } = await failingPages(subset, combine([...kept, ...together, ...(requirement ? [/** @type {Evaluation} */ (evaluations.get(requirement))] : []), evaluation]), { detail: `${evaluation.name} added`, counter, total: testable.length * subset.length });
        if (own.length) {
          const others = together.map((other) => `\`${other.name}\``).join(', ');
          await demote(evaluation, renderReasons(own).map((reason) => ({ ...reason, message: `${reason.message}, together with ${others || 'kept options'}` })));
        } else {
          together.push(evaluation);
        }
      }
    }
    if (round === MAX_RENDER_ROUNDS) {
      renderLimitReached = true;
      notes.add('Rendering still differed after the maximum number of rounds; the configuration may not look the same');
    }
    for (const evaluation of inUse()) {
      const checks = evaluation.reasons.filter((reason) => reason.level === 'check');
      const settled = checks.length && !checks.some((reason) => reason.page !== undefined && pagesUnchecked.has(reason.page));
      if (settled && !evaluation.reasons.some((reason) => reason.message === MESSAGE_RENDERS_SAME)) {
        evaluation.reasons.push({ level: 'info', message: MESSAGE_RENDERS_SAME });
      }
    }
  }

  // 2. All accepted candidates together, rendered
  await settleRendering();

  /**
   * Measures what each option in use contributes, dropping those that gain nothing alongside
   * the others
   * @returns {Promise<boolean>} Whether any were dropped
   */
  async function settleContributions() {
    let dropped = false;
    for (let changed = true; changed;) {
      changed = false;
      const used = inUse();
      const final = await totalOf(combine(used));
      for (const [index, evaluation] of used.entries()) {
        onProgress({ phase: 'contribute', detail: evaluation.name, current: index, total: used.length });
        await yieldTurn();
        const without = used.filter((other) => other !== evaluation && requirementOf(other.name) !== evaluation.name);
        evaluation.contribution = await totalOf(combine(without)) - final;
      }
      const [weakest] = used
        .filter((evaluation) => evaluation.status === 'accepted' && (evaluation.contribution ?? 0) <= 0)
        .sort((a, b) => (a.contribution ?? 0) - (b.contribution ?? 0));
      if (weakest) {
        weakest.status = 'no-gain';
        weakest.reasons.push({ level: 'info', message: `Saves nothing alongside the other options (${weakest.contribution} B by ${metric})` });
        delete weakest.contribution;
        dropDependents(weakest);
        changed = true;
        dropped = true;
      }
    }
    return dropped;
  }

  // 3. What each option contributes; as fewer options may render differently, too, rendering
  // is settled again until no more are dropped
  while (await settleContributions() && renderer) await settleRendering();
  const options = combine(inUse());
  // Measured while presets render
  const measuring = Promise.all([sizesOf(base), sizesOf(options)]);

  // 4. HTML Minifier’s presets for comparison
  const presetsCompared = presets ? Object.entries(PRESETS) : [];
  let presetsDone = 0;
  onProgress({ phase: 'presets', detail: presetsCompared.map(([name]) => name).join(', '), current: 0, total: presetsCompared.length });
  /** @type {PresetComparison[]} */
  const comparisons = await Promise.all(presetsCompared.map(async ([name, preset]) => {
    const optionsPreset = { ...base, ...preset };
    /** @type {{page: import('./pages.js').Page, html: string}[]} */
    const minified = [];
    let errors = 0;
    for (const page of pages) {
      try {
        minified.push({ page, html: await run(page, optionsPreset) });
      } catch {
        errors++;
      }
      await yieldTurn();
    }
    const verdicts = renderer ? await Promise.all(minified.map(({ page, html }) => renderer.compare(page, html))) : null;
    onProgress({ phase: 'presets', detail: name, current: ++presetsDone, total: presetsCompared.length });
    return {
      name,
      size: await totalSize(minified.map(({ html }) => html)),
      failing: verdicts ? verdicts.filter((verdict) => !verdict.equal && !verdict.inconclusive).length : null,
      errors,
      rejected: Object.keys(preset).filter((key) => /** @type {Record<string, unknown>} */ (preset)[key] && evaluations.get(key)?.status === 'rejected')
    };
  }));
  const [baseline, final] = await measuring;

  return {
    metric,
    options,
    baseline,
    final,
    evaluations: [...evaluations.values()],
    pages: pages.map((page) => page.id),
    rendered: Boolean(renderer),
    equivalence: equivalence?.source ?? null,
    notes: [...notes],
    presets: comparisons,
    renderedSame: Boolean(renderer) && !renderLimitReached && !pagesUnchecked.size,
    viewports: (renderer?.viewports ?? []).map(({ width, height }) => `${width}×${height}`),
    browser: renderer?.browser ?? null
  };
}