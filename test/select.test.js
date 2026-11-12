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

describe('customize', () => {
  test('Accepts options that save bytes and reports those without effect', async () => {
    const result = await customize(pageHome);
    assert.strictEqual(evaluation(result, 'collapseWhitespace').status, 'accepted');
    assert.strictEqual(evaluation(result, 'removeComments').status, 'accepted');
    assert.strictEqual(evaluation(result, 'minifySVG').status, 'no-effect');
    assert.strictEqual(result.options.collapseWhitespace, true);
    assert.ok(!('minifySVG' in result.options));
    assert.ok(result.final.gzip < result.baseline.gzip);
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
    assert.strictEqual(evaluation(result, 'minifyCSS').status, 'no-effect');
    const unused = evaluation(result, 'removeUnusedCSS');
    assert.strictEqual(unused.status, 'accepted');
    assert.ok(unused.savings > 0);
    assert.match(unused.reasons.map((reason) => reason.message).join('\n'), /Brings in `minifyCSS`/);
    assert.strictEqual(result.options.minifyCSS, true);
    assert.strictEqual(result.options.removeUnusedCSS, true);
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
    assert.ok((comprehensive?.sizes.gzip ?? 0) > 0);
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
});