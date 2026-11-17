import { describe, test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPage, loadPages } from '../src/pages.js';
import { customize } from '../src/select.js';

const dirSite = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'site');
const pages = await loadPages([dirSite]);
const pageHome = pages.filter((page) => page.id === 'index.html');
const pagePoem = pages.filter((page) => page.id === 'poem.html');
const pageApp = pages.filter((page) => page.id === 'blog/app.html');

/**
 * @param {import('../src/select.js').Result} result
 * @param {string} name
 */
const evaluation = (result, name) => {
  const found = result.evaluations.find((item) => item.name === name);
  assert.ok(found, `No evaluation for ${name}`);
  return found;
};

/**
 * A renderer whose verdict comes from the markup alone
 * @param {(html: string) => boolean} isEqual
 */
const fakeRenderer = (isEqual) => {
  const calls = { count: 0 };
  return {
    calls,
    /** @param {import('../src/pages.js').Page} _page @param {string} html */
    async compare(_page, html) {
      calls.count++;
      return isEqual(html) ? { equal: true, reasons: [], notes: [] } : { equal: false, reasons: ['Renders differently'], notes: [] };
    },
    async close() {}
  };
};

describe('`customize`', () => {
  test('Accepts options that save bytes and reports those without effect', async () => {
    const result = await customize(pageHome);
    assert.strictEqual(evaluation(result, 'collapseWhitespace').status, 'accepted');
    assert.strictEqual(evaluation(result, 'removeComments').status, 'accepted');
    assert.strictEqual(evaluation(result, 'minifySVG').status, 'no-effect');
    assert.strictEqual(result.options.collapseWhitespace, true);
    assert.ok(!('minifySVG' in result.options));
    assert.ok(result.final.gzip < result.baseline.gzip);
  });

  test('Tells options in effect already from those with nothing to act on, recommending neither', async () => {
    const page = createPage({ id: 'minified.html', html: '<!doctype html><p class=a title="b c">Text<input disabled>', resources: {} });
    const result = await customize([page]);
    for (const name of ['collapseBooleanAttributes', 'removeAttributeQuotes', 'useShortDoctype']) {
      const found = evaluation(result, name);
      assert.strictEqual(found.status, 'in-effect', name);
      assert.match(found.reasons[0]?.message ?? '', /in the form it produces already/, name);
      assert.ok(!(name in result.options), name);
    }
    assert.strictEqual(evaluation(result, 'minifySVG').status, 'no-effect');
    assert.strictEqual(evaluation(result, 'removeComments').status, 'no-effect');
  });

  test('Attributes savings to each accepted option', async () => {
    const result = await customize(pageHome);
    const collapse = evaluation(result, 'collapseWhitespace');
    assert.ok(collapse.savings > 0);
    assert.ok((collapse.contribution ?? 0) > 0);
    assert.strictEqual(evaluation(result, 'minifySVG').contribution, undefined);
  });

  test('Evaluates options together with what they need where that saves nothing alone', async () => {
    const page = createPage({ id: 'minified.html', html: '<style>.a{color:red}.unused{color:#00f}</style><p class=a>x</p>', resources: {} });
    const result = await customize([page]);
    assert.strictEqual(evaluation(result, 'minifyCSS').status, 'in-effect');
    const unused = evaluation(result, 'removeUnusedCSS');
    assert.strictEqual(unused.status, 'accepted');
    assert.ok(unused.savings > 0);
    assert.match(unused.reasons.map((reason) => reason.message).join('\n'), /Brings in `minifyCSS`/);
    assert.strictEqual(result.options.minifyCSS, true);
    assert.strictEqual(result.options.removeUnusedCSS, true);
  });

  test('Drops kept options whose requirement is rejected later', async () => {
    const page = createPage({ id: 'kept.html', html: '<style>.a { color: red }\n.unused { color: blue }</style><p class=a>x</p>', resources: {} });
    const renderer = fakeRenderer((html) => html.includes('.a { color: red }'));
    const result = await customize([page], { keep: ['removeUnusedCSS'], renderer, presets: false });
    assert.strictEqual(evaluation(result, 'minifyCSS').status, 'rejected');
    const unused = evaluation(result, 'removeUnusedCSS');
    assert.strictEqual(unused.status, 'rejected');
    assert.match(unused.reasons.map((reason) => reason.message).join('\n'), /Needs `minifyCSS`/);
    assert.ok(!('removeUnusedCSS' in result.options));
  });

  test('Doesn’t reject options for what kept options change in rendering', async () => {
    // Only removing comments looks different
    const renderer = fakeRenderer((html) => html.includes('<!--'));
    const result = await customize(pageHome, { keep: ['removeComments'], renderer, presets: false });
    assert.strictEqual(evaluation(result, 'removeComments').status, 'kept');
    assert.strictEqual(evaluation(result, 'collapseWhitespace').status, 'accepted');
    assert.deepStrictEqual(result.evaluations.filter((item) => item.reasons.some((reason) => reason.level === 'render')).map((item) => item.name), []);
    assert.strictEqual(result.renderedSame, false);
    assert.match(result.notes.join('\n'), /index\.html: Looks different with the kept options alone/);
    assert.doesNotMatch(result.notes.join('\n'), /rounds of setting options aside/);
  });

  test('Render-checks pages sharing an ID with one that kept options make look different', async () => {
    // From different roots: Removing comments changes the first, collapsing whitespace the second
    const pageComment = createPage({ id: 'index.html', html: '<!-- x --><p>a</p>', resources: {} });
    const pageSpace = createPage({ id: 'index.html', html: '<p>a</p>\n\n<p>b</p>', resources: {} });
    const renderer = {
      /** @param {import('../src/pages.js').Page} page @param {string} html */
      async compare(page, html) {
        const equal = page === pageComment ? html.includes('<!--') : html.includes('\n');
        return equal ? { equal: true, reasons: [], notes: [] } : { equal: false, reasons: ['Renders differently'], notes: [] };
      },
      async close() {}
    };
    const result = await customize([pageComment, pageSpace], { keep: ['removeComments'], renderer, presets: false });
    const collapse = evaluation(result, 'collapseWhitespace');
    assert.ok(collapse.reasons.some((reason) => reason.level === 'render' && reason.page === 'index.html'));
    assert.strictEqual(collapse.variant, 'preserveLineBreaks');
  });

  test('Doesn’t evaluate options whose requirement is rejected or skipped', async () => {
    const result = await customize(pageHome, { skip: ['minifyCSS'] });
    const unused = evaluation(result, 'removeUnusedCSS');
    assert.strictEqual(unused.status, 'skipped');
    assert.match(unused.reasons[0]?.message ?? '', /Not evaluated, as it needs `minifyCSS`, which was skipped/);
  });

  test('Compares the result with HTML Minifier’s presets, rendered', async () => {
    const result = await customize(pageHome, { renderer: fakeRenderer((html) => html.includes('</p>')) });
    const [conservative, comprehensive] = result.presets;
    assert.strictEqual(conservative?.name, 'conservative');
    assert.strictEqual(conservative?.failing, 0);
    assert.strictEqual(comprehensive?.name, 'comprehensive');
    assert.strictEqual(comprehensive?.failing, 1);
    assert.ok((comprehensive?.size ?? 0) > 0);
  });

  test('Reports the viewports rendered at and whether the result looks the same', async () => {
    const renderer = { ...fakeRenderer(() => true), viewports: [{ width: 1280, height: 800 }], browser: 'Chrome 157' };
    const result = await customize(pageHome, { renderer, presets: false });
    assert.strictEqual(result.renderedSame, true);
    assert.strictEqual(result.browser, 'Chrome 157');
    assert.deepStrictEqual(result.viewports, ['1280×800']);
  });

  test('Notes options of the installed HTML Minifier it doesn’t evaluate', async () => {
    const result = await customize(pageHome, { presets: false, schema: { version: '9.0.0', options: ['collapseWhitespace', 'newOption'] } });
    assert.ok(result.notes.includes('HTML Minifier 9.0.0 has options this version of HTML Minifier Setup doesn’t evaluate yet: newOption'));
    assert.ok(!(await customize(pageHome, { presets: false })).notes.some((note) => note.includes('doesn’t evaluate yet')));
  });

  test('Names options presets include that were rejected', async () => {
    const result = await customize(pageApp);
    assert.ok(result.presets[0]?.rejected.includes('removeComments'));
  });

  test('Names options presets include in a form that was rejected, where a gentler one fits', async () => {
    const renderer = fakeRenderer((html) => /red,<\/span>[ \t]*\n\s*<span>violets/.test(html));
    const result = await customize(pagePoem, { renderer, metric: 'raw' });
    assert.strictEqual(evaluation(result, 'collapseWhitespace').variant, 'preserveLineBreaks');
    const [conservative, comprehensive] = result.presets;
    assert.ok(!conservative?.rejected.includes('collapseWhitespace'));
    assert.ok(comprehensive?.rejected.includes('collapseWhitespace'));
  });

  test('Names the compression method capitalized where an option saves nothing', async () => {
    const reasons = (await customize(pageHome, { presets: false })).evaluations.flatMap((item) => item.reasons.map((reason) => reason.message));
    assert.ok(reasons.some((message) => /^Saves nothing with Gzip$/.test(message)), reasons.join('\n'));
  });

  test('Notes how many pages the sample was taken from, where it left any out', async () => {
    assert.strictEqual((await customize(pageHome, { presets: false, pagesFound: 1234 })).pagesFound, 1234);
    assert.strictEqual((await customize(pageHome, { presets: false, pagesFound: 1 })).pagesFound, null);
    assert.strictEqual((await customize(pageHome, { presets: false })).pagesFound, null);
  });

  test('Compares with presets unrendered without a renderer, or not at all if asked', async () => {
    const result = await customize(pageHome);
    assert.strictEqual(result.presets[0]?.failing, null);
    assert.deepStrictEqual((await customize(pageHome, { presets: false })).presets, []);
  });

  test('Rejects options with risks found on the page', async () => {
    const result = await customize(pageApp);
    const unused = evaluation(result, 'removeUnusedCSS');
    assert.strictEqual(unused.status, 'rejected');
    assert.match(unused.reasons[0]?.message ?? '', /is-open/);
    assert.strictEqual(evaluation(result, 'removeEmptyElements').status, 'rejected');
    assert.strictEqual(evaluation(result, 'removeComments').status, 'rejected');
    assert.strictEqual(evaluation(result, 'removeRedundantAttributes').status, 'rejected');
  });

  test('Keeps risky options when asked to', async () => {
    const result = await customize(pageApp, { keep: ['removeComments'] });
    assert.strictEqual(evaluation(result, 'removeComments').status, 'kept');
    assert.strictEqual(result.options.removeComments, true);
  });

  test('Skips options when asked to', async () => {
    const result = await customize(pageHome, { skip: ['collapseWhitespace'] });
    assert.strictEqual(evaluation(result, 'collapseWhitespace').status, 'skipped');
    assert.strictEqual(evaluation(result, 'collapseInlineTagWhitespace').status, 'skipped');
    assert.match(evaluation(result, 'collapseInlineTagWhitespace').reasons[0]?.message ?? '', /collapseWhitespace/);
  });

  test('Rejects options left to a render check when there is no renderer', async () => {
    const result = await customize(pagePoem);
    const collapse = evaluation(result, 'collapseWhitespace');
    assert.strictEqual(collapse.status, 'rejected');
    assert.ok(collapse.reasons.some((reason) => reason.level === 'check'));
    assert.strictEqual(result.rendered, false);
  });

  test('Falls back to gentler whitespace collapsing where rendering requires it', async () => {
    // As CSS keeps line breaks in the poem, only output keeping them renders the same
    const renderer = fakeRenderer((html) => /red,<\/span>[ \t]*\n\s*<span>violets/.test(html));
    const result = await customize(pagePoem, { renderer, metric: 'raw' });
    const collapse = evaluation(result, 'collapseWhitespace');
    assert.strictEqual(collapse.status, 'accepted');
    assert.strictEqual(collapse.variant, 'preserveLineBreaks');
    assert.deepStrictEqual(collapse.options, { collapseWhitespace: true, conservativeCollapse: true, preserveLineBreaks: true });
    assert.strictEqual(result.options.preserveLineBreaks, true);
    assert.strictEqual(result.rendered, true);
  });

  test('Rejects the options that make pages render differently', async () => {
    const renderer = fakeRenderer((html) => html.includes('Main content'));
    const result = await customize(pageHome, { renderer });
    const comments = evaluation(result, 'removeComments');
    assert.strictEqual(comments.status, 'rejected');
    assert.ok(comments.reasons.some((reason) => reason.level === 'render'));
    assert.strictEqual(evaluation(result, 'collapseWhitespace').status, 'accepted');
    assert.ok(renderer.calls.count > 0);
  });

  test('Resolves options that only break rendering together', async () => {
    const renderer = fakeRenderer((html) => !(html.includes('type=search') && !html.includes('<!--')));
    const result = await customize(pageHome, { renderer });
    const quotes = evaluation(result, 'removeAttributeQuotes');
    const comments = evaluation(result, 'removeComments');
    assert.strictEqual([quotes.status, comments.status].filter((status) => status === 'rejected').length, 1);
    assert.match([...quotes.reasons, ...comments.reasons].map((reason) => reason.message).join(), /together/);
  });

  test('Rejects options whose output the equivalence check flags', async () => {
    const equivalence = {
      source: 'test',
      supports: () => true,
      /** @param {string} _input @param {string} _output @param {Record<string, unknown>} options */
      compare: (_input, _output, options) => options.removeOptionalTags ? ['tree: a → b'] : []
    };
    const result = await customize(pageHome, { equivalence });
    const optional = evaluation(result, 'removeOptionalTags');
    assert.strictEqual(optional.status, 'rejected');
    assert.strictEqual(optional.reasons[0]?.level, 'equivalence');
    assert.strictEqual(result.equivalence, 'test');
  });

  test('Leaves options the equivalence check doesn’t model to other checks', async () => {
    const equivalence = {
      source: 'test',
      supports: (/** @type {string} */ name) => name !== 'removeOptionalTags',
      compare: () => ['tree: a → b']
    };
    const result = await customize(pageHome, { equivalence });
    assert.strictEqual(evaluation(result, 'removeOptionalTags').status, 'accepted');
    assert.strictEqual(evaluation(result, 'collapseWhitespace').status, 'rejected');
  });

  test('Rejects options the minifier fails with', async () => {
    /** @param {string} html @param {Record<string, unknown>} options */
    const minify = async (html, options) => {
      if (options.sortAttributes) throw new Error('Boom');
      const { minify: minifyHM } = await import('html-minifier');
      return minifyHM(html, options);
    };
    const result = await customize(pageHome, { minify });
    const sort = evaluation(result, 'sortAttributes');
    assert.strictEqual(sort.status, 'rejected');
    assert.match(sort.reasons[0]?.message ?? '', /Boom/);
  });

  test('Evaluates candidate values from a given configuration', async () => {
    const result = await customize(pageHome, { values: { minifyJS: { compress: false, mangle: false } } });
    assert.deepStrictEqual(evaluation(result, 'minifyJS').options, { minifyJS: { compress: false, mangle: false } });
  });

  test('Leaves out pages the minifier can’t read, noting why', async () => {
    const broken = createPage({ id: 'broken.html', html: '<p><a href="x""target="_blank">a</a>' });
    const result = await customize([...pageHome, broken]);
    assert.deepStrictEqual(result.pages, ['index.html']);
    assert.match(result.notes.join(), /broken\.html/);
  });

  test('Fails where the minifier can read no page', async () => {
    const broken = createPage({ id: 'broken.html', html: '<p><a href="x""target="_blank">a</a>' });
    await assert.rejects(customize([broken]), /continueOnParseError/);
  });

  test('Carries base options into every run and the result', async () => {
    const result = await customize(pageHome, { base: { caseSensitive: true } });
    assert.strictEqual(result.options.caseSensitive, true);
  });

  test('Judges gains by the chosen metric', async () => {
    const result = await customize(pageHome, { metric: 'raw' });
    assert.strictEqual(result.metric, 'raw');
    assert.strictEqual(evaluation(result, 'sortAttributes').status, 'no-gain');
  });

  test('Evaluates pages that share an ID independently', async () => {
    const pageA = createPage({ id: 'index.html', html: '<p>a   b</p>', resources: {} });
    const pageB = createPage({ id: 'index.html', html: '<p>another   page,   longer</p>', resources: {} });
    const [both, onlyA, onlyB] = await Promise.all([[pageA, pageB], [pageA], [pageB]].map((list) => customize(list, { presets: false })));
    assert.strictEqual(both.baseline.raw, onlyA.baseline.raw + onlyB.baseline.raw);
  });

  test('Doesn’t claim the configuration looks the same where render checks were inconclusive', async () => {
    const renderer = {
      async compare() {
        return { equal: false, inconclusive: true, reasons: [], notes: ['Looks and reads different between loads'] };
      },
      async close() {}
    };
    const result = await customize(pagePoem, { renderer, presets: false });
    assert.strictEqual(result.renderedSame, false);
    const collapse = evaluation(result, 'collapseWhitespace');
    assert.strictEqual(collapse.status, 'accepted');
    assert.ok(collapse.reasons.some((reason) => reason.level === 'check'));
    assert.ok(!collapse.reasons.some((reason) => reason.message === 'Looks the same where checks were needed'));
    const withPresets = await customize(pagePoem, { renderer });
    assert.deepStrictEqual(withPresets.presets.map((preset) => [preset.failing, preset.inconclusive]), [[0, 1], [0, 1]]);
  });

  test('Takes render checks that fail as inconclusive, naming the page', async () => {
    const renderer = {
      /** @param {import('../src/pages.js').Page} page */
      async compare(page) {
        if (page.id === 'poem.html') throw new Error('Navigation timeout');
        return { equal: true, inconclusive: false, reasons: [], notes: [] };
      },
      async close() {}
    };
    const result = await customize([...pageHome, ...pagePoem], { renderer });
    assert.strictEqual(result.renderedSame, false);
    assert.ok(result.notes.some((note) => /^poem\.html: .*Navigation timeout/.test(note)), result.notes.join('\n'));
    assert.strictEqual(evaluation(result, 'removeComments').status, 'accepted');
    assert.ok(result.presets.every((preset) => preset.inconclusive === 1));
  });

  test('Render-checks options against the pages minified without options, noting where those look different', async () => {
    // Removing `htmlmin:ignore` comments, as HTML Minifier does without options, looks different
    const page = createPage({ id: 'ignore.html', html: '<p>a <!-- htmlmin:ignore -->b<!-- htmlmin:ignore -->\n\n<!-- c --><p>d</p>', resources: {} });
    const renderer = {
      /** @param {import('../src/pages.js').Page} reference @param {string} html */
      async compare(reference, html) {
        const equal = reference.html.includes('htmlmin:ignore') === html.includes('htmlmin:ignore');
        return equal ? { equal: true, reasons: [], notes: [] } : { equal: false, reasons: ['Looks different at 800×600'], notes: [] };
      },
      async close() {}
    };
    const result = await customize([page], { renderer, presets: false });
    assert.strictEqual(evaluation(result, 'removeComments').status, 'accepted');
    assert.ok(result.notes.some((note) => /^ignore\.html: HTML Minifier changes it even without options \(e\.g\., by removing `htmlmin:ignore` comments\)—Looks different at 800×600; options were render-checked against that$/.test(note)), result.notes.join('\n'));
    assert.strictEqual(result.renderedSame, false);
  });

  test('Keeps from calling pages the same where comparing them with HTML Minifier’s output without options failed, noting why', async () => {
    const page = createPage({ id: 'ignore.html', html: '<p>a <!-- htmlmin:ignore -->b<!-- htmlmin:ignore -->\n\n<!-- c --><p>d</p>', resources: {} });
    const renderer = {
      /** @param {import('../src/pages.js').Page} reference */
      async compare(reference) {
        if (reference.html.includes('htmlmin:ignore')) throw new Error('Navigation timeout');
        return { equal: true, reasons: [], notes: ['Text differs between loads at 800×600, so text wasn’t compared'] };
      },
      async close() {}
    };
    const result = await customize([page], { renderer, presets: false });
    assert.strictEqual(evaluation(result, 'removeComments').status, 'accepted');
    assert.strictEqual(result.renderedSame, false);
    assert.ok(result.notes.some((note) => /^ignore\.html: .*Navigation timeout/.test(note)), result.notes.join('\n'));
    assert.ok(result.notes.includes('ignore.html: Couldn’t tell whether HTML Minifier changes it even without options; options were render-checked against its output without them'), result.notes.join('\n'));
  });

  test('Tells how far elements move, where that is all that differs', async () => {
    const renderer = {
      /** @param {import('../src/pages.js').Page} _page @param {string} html */
      async compare(_page, html) {
        return html.includes('</p>') ? { equal: true, reasons: [], notes: [] } : { equal: false, reasons: ['Moves elements by up to 4 px at 800×600 (e.g., p)'], notes: [], shift: 4 };
      },
      async close() {}
    };
    const result = await customize(pageHome, { renderer });
    const optional = evaluation(result, 'removeOptionalTags');
    assert.strictEqual(optional.status, 'rejected');
    assert.ok(optional.reasons.some((reason) => reason.level === 'render' && reason.shift === 4));
    assert.strictEqual(result.presets.find((preset) => preset.name === 'comprehensive')?.shift, 4);
    assert.strictEqual(result.presets.find((preset) => preset.name === 'conservative')?.shift, null);
  });

  test('Reports files that didn’t load in the render check, no longer finding the configuration to look the same', async () => {
    const renderer = {
      async compare() {
        return { equal: true, inconclusive: false, reasons: [], notes: [], failed: ['https://cdn.example/a.css'] };
      },
      async close() {}
    };
    const result = await customize(pageHome, { renderer, presets: false });
    assert.deepStrictEqual(result.failed, ['https://cdn.example/a.css']);
    assert.strictEqual(result.renderedSame, false);
  });

  test('Reports files the render check didn’t get, no longer finding the configuration to look the same', async () => {
    const renderer = {
      /** @param {import('../src/pages.js').Page} page */
      async compare(page) {
        return { equal: true, inconclusive: false, reasons: [], notes: [], blocked: page.id === 'poem.html' ? ['shared/poem.css'] : [] };
      },
      async close() {}
    };
    const result = await customize([...pageHome, ...pagePoem], { renderer, presets: false });
    assert.deepStrictEqual(result.blocked, ['shared/poem.css']);
    assert.strictEqual(result.renderedSame, false);
    const resultServed = await customize(pageHome, { renderer, presets: false });
    assert.deepStrictEqual(resultServed.blocked, []);
    assert.strictEqual(resultServed.renderedSame, true);
  });
});