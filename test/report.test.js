import { describe, test } from 'node:test';
import assert from 'node:assert';
import { formatConfiguration, formatReport, hasRecommendation, toMatchingConfig, toPresetConfig } from '../src/report.js';
import { MESSAGE_RENDERS_SAME } from '../src/select.js';

const ESC = '\u001b';
const SIZES = { raw: 1000, gzip: 400, brotli: 300 };

/**
 * A result with the given final sizes and evaluations
 * @param {import('../src/measure.js').Sizes} final
 * @param {Partial<import('../src/select.js').Evaluation>[]} [evaluations]
 * @returns {import('../src/select.js').Result}
 */
const resultOf = (final, evaluations = []) => ({
  metric: 'gzip',
  options: {},
  baseline: SIZES,
  final,
  evaluations: evaluations.map((evaluation, index) => ({ name: `option${index}`, options: {}, status: 'accepted', savings: 0, reasons: [], ...evaluation })),
  pages: ['index.html'],
  rendered: false,
  equivalence: null,
  pagesFound: null,
  notes: [],
  presets: [],
  blocked: [],
  failed: [],
  allowShift: 0,
  renderedSame: false,
  viewports: [],
  browser: null
});

describe('`formatReport`', () => {
  test('Shows savings in green and growth in red, with a sign', () => {
    const report = formatReport(resultOf({ raw: 900, gzip: 410, brotli: 300 }), { color: true });
    assert.match(report, new RegExp(`Uncompressed: .*${ESC}\\[32m−10\\.0%`));
    assert.match(report, new RegExp(`Gzip:${ESC}\\[0m .*${ESC}\\[31m\\+2\\.5%`));
    assert.match(report, /Brotli: .*±0%/);
  });

  test('Mentions the equivalence check only where it ran, as in development', () => {
    assert.doesNotMatch(formatReport(resultOf(SIZES)), /quivalence/);
    assert.match(formatReport({ ...resultOf(SIZES), equivalence: '../html-minifier' }), /^• Equivalence-checked with \.\.\/html-minifier$/m);
  });

  test('Names how many pages the sample was taken from, and how to evaluate more', () => {
    assert.match(formatReport({ ...resultOf(SIZES), pagesFound: 1234 }), /^• Evaluated 1 of 1,234 pages \(use `--sample` to evaluate more\), judging/m);
    assert.doesNotMatch(formatReport(resultOf(SIZES)), /--sample/);
  });

  test('Names compression methods as words, capitalized', () => {
    const report = formatReport({ ...resultOf(SIZES), metric: 'brotli', presets: [{ name: 'conservative', size: 300, failing: null, inconclusive: null, errors: 0, rejected: [] }] });
    assert.match(report, /judging gains by Brotli size/);
    assert.match(report, /compared with HTML Minifier’s presets \(Brotli\):/);
    assert.match(formatReport({ ...resultOf(SIZES), metric: 'raw' }), /judging gains by uncompressed size/);
  });

  test('Uses no escape codes without color', () => {
    const report = formatReport(resultOf({ raw: 900, gzip: 410, brotli: 300 }));
    assert.doesNotMatch(report, new RegExp(ESC));
    assert.match(report, /Gzip: .*\+2\.5%/);
  });

  test('Differs only by escape codes where colored, keeping columns aligned', () => {
    const result = resultOf(SIZES, [
      { name: 'collapseWhitespace', status: 'accepted', variant: 'conservativeCollapse', savings: 40, contribution: 38 },
      { name: 'removeComments', status: 'rejected', savings: 5, reasons: [{ level: 'render', page: 'a.html', message: 'Looks different at 1280×800' }] },
      { name: 'sortAttributes', status: 'no-gain' }
    ]);
    Object.assign(result, { rendered: true, renderedSame: true, notes: ['A note'] });
    result.presets = [{ name: 'conservative', size: 440, failing: 0, inconclusive: 0, errors: 0, rejected: ['removeComments'] }];
    assert.strictEqual(formatReport(result, { color: true }).replace(new RegExp(`${ESC}\\[\\d+m`, 'g'), ''), formatReport(result));
  });

  test('Marks the configuration looking the same in green, where colored', () => {
    const result = resultOf(SIZES);
    Object.assign(result, { rendered: true, renderedSame: true });
    assert.match(formatReport(result, { color: true }), new RegExp(`^• ${ESC}\\[32mRender-checked .*looks the same as the original pages${ESC}\\[0m$`, 'm'));
  });

  test('Sets headings and the size judged by in bold, where colored', () => {
    const result = resultOf(SIZES, [{ name: 'removeComments', status: 'rejected', savings: 5, reasons: [{ level: 'risk', page: 'a.html', message: 'Removes a comment' }] }]);
    result.notes = ['A note'];
    result.presets = [{ name: 'conservative', size: 440, failing: null, inconclusive: null, errors: 0, rejected: [] }];
    const report = formatReport(result, { color: true });
    for (const heading of ['Option', 'Status', 'Saves alone', 'Details:', 'Notes:', 'Gzip:']) assert.match(report, new RegExp(`${ESC}\\[1m${heading}${ESC}\\[0m`));
    assert.match(report, new RegExp(`${ESC}\\[1mPages without options compared with HTML Minifier’s presets \\(Gzip\\):${ESC}\\[0m`));
    assert.doesNotMatch(report, new RegExp(`${ESC}\\[1m(Uncompressed|Brotli):`));
  });

  test('Dims hints, where colored', () => {
    const reason = { level: /** @type {const} */ ('risk'), message: 'Removes a comment' };
    const report = formatReport(resultOf(SIZES, [{ status: 'rejected', reasons: [{ ...reason, page: 'a.html' }, { ...reason, page: 'b.html' }] }]), { color: true });
    assert.match(report, new RegExp(`${ESC}\\[2m\\(Run with \`-v\` for every page and viewport\\)${ESC}\\[0m`));
    assert.match(report, new RegExp(`${ESC}\\[2mChecks can show that options change these pages, not that they never will\\.${ESC}\\[0m$`));
  });

  test('Points out pages that look minified already, by whitespace collapsing saving next to nothing', () => {
    const noEffect = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'no-effect' }, { status: 'no-effect' }, { status: 'accepted' }]));
    assert.match(noEffect, /look minified already: Collapsing whitespace saves less than 1%, and 2 of 3 options change nothing/);
    const little = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'no-gain', savings: 2 }]));
    assert.match(little, /look minified already/);
  });

  test('Doesn’t take options without effect for minification', () => {
    const plain = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'accepted', savings: 40 }, { status: 'no-effect' }, { status: 'no-effect' }, { status: 'no-effect' }]));
    assert.doesNotMatch(plain, /minified already/);
  });

  test('Names files the render check didn’t get past symbolic links, no longer calling pages the same, as they may change the outcome', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 }, [{ reasons: [{ level: 'check', page: 'index.html', message: 'Collapses whitespace that CSS keeps' }, { level: 'info', message: MESSAGE_RENDERS_SAME }] }]);
    result.rendered = true;
    result.blocked = ['a.css', 'b.css', 'c.css', 'fonts/a.woff2'];
    const report = formatReport(result);
    assert.match(report, /: The recommended configuration may not look the same as the original pages, as files outside the site were missing\n• Rendered without 4 files that symbolic links lead to outside the site \(a\.css, b\.css, c\.css, and 1 more\), which may change how pages look—`--follow-links` follows them\n\n/);
    assert.match(report, /Info: Looks the same where checks were needed, but without files outside the site\n/);
    result.blocked = [];
    result.renderedSame = true;
    const reportServed = formatReport(result);
    assert.doesNotMatch(reportServed, /symbolic links|outside the site/);
    assert.match(reportServed, /: The recommended configuration looks the same as the original pages\n/);
  });

  test('Names files that didn’t load in the render check, no longer calling pages the same', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 });
    result.rendered = true;
    result.failed = ['https://cdn.example/a.css'];
    const report = formatReport(result);
    assert.match(report, /: The recommended configuration may not look the same as the original pages, as files didn’t load\n• Rendered without 1 file that didn’t load \(https:\/\/cdn\.example\/a\.css\), which may change how pages look\n\n/);
  });

  test('Names the shift allowed, if any', () => {
    const result = resultOf(SIZES);
    Object.assign(result, { rendered: true, renderedSame: true, viewports: ['800×600'], browser: 'Chrome 157', allowShift: 12 });
    assert.match(formatReport(result), /^• Render-checked in Chrome 157 at 800×600, allowing elements to move by up to 12 px: The recommended/m);
  });

  test('Marks the text of lines that warn the rendering may differ in yellow, where colored', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 });
    result.rendered = true;
    result.blocked = ['a.css'];
    const lines = formatReport(result, { color: true }).split('\n');
    assert.deepStrictEqual(lines.filter((line) => line.includes(`${ESC}[33m`)).map((line) => line.replace(new RegExp(`${ESC}\\[\\d+m`, 'g'), '').slice(0, 20)), ['• Render-checked in ', '• Rendered without 1']);
    assert.ok(lines.filter((line) => line.includes(`${ESC}[33m`)).every((line) => line.startsWith(`• ${ESC}[33m`)));
    result.blocked = [];
    assert.match(formatReport(result, { color: true }), new RegExp(`• ${ESC}\\[33mRender-checked .*may not look the same`));
    result.renderedSame = true;
    assert.ok(!formatReport(result, { color: true }).includes(`${ESC}[33m`));
  });

  test('Lists notes with markers', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 });
    result.notes = ['First note', 'Second note'];
    assert.match(formatReport(result), /\nNotes:\n• First note\n• Second note\n/);
  });

  test('Compares presets with the recommended configuration, by a row of its own', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 }, [{ status: 'accepted', savings: 10 }]);
    result.presets = [{ name: 'conservative', size: 440, failing: null, inconclusive: null, errors: 0, rejected: [] }];
    assert.match(formatReport(result), /\nRecommended configuration compared with HTML Minifier’s presets \(Gzip\):\n {2}recommended +400 B\n {2}conservative +440 B +10\.0% larger +not render-checked\n/);
  });

  test('Compares presets with pages without options, where there’s no recommendation', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 }, [{ status: 'no-gain' }]);
    result.presets = [{ name: 'conservative', size: 400, failing: null, inconclusive: null, errors: 0, rejected: [] }];
    assert.match(formatReport(result), /\nPages without options compared with HTML Minifier’s presets \(Gzip\):\n {2}without options +400 B\n {2}conservative +400 B +same size +not render-checked\n/);
  });

  test('Compares the result with presets', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 });
    result.presets = [
      { name: 'conservative', size: 440, failing: 0, inconclusive: 0, errors: 0, rejected: ['removeComments'] },
      { name: 'comprehensive', size: 380, failing: 1, inconclusive: 0, errors: 0, rejected: [] }
    ];
    const report = formatReport(result);
    assert.match(report, /conservative +440 B +10\.0% larger +looks the same; includes `removeComments`, which doesn’t fit/);
    assert.match(report, /comprehensive +380 B +5\.0% smaller +looks different on 1 of 1 page/);
  });

  test('Qualifies preset render checks by the pages the preset could minify', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 });
    result.pages = ['a.html', 'b.html', 'c.html'];
    result.presets = [{ name: 'conservative', size: 440, failing: 0, inconclusive: 0, errors: 1, rejected: [] }];
    assert.match(formatReport(result), /conservative +fails on 1 of 3 +looks the same on the other 2 pages/);
  });

  test('Reports preset render checks that were inconclusive', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 });
    result.pages = ['a.html', 'b.html', 'c.html'];
    result.presets = [
      { name: 'conservative', size: 440, failing: 0, inconclusive: 3, errors: 0, rejected: [] },
      { name: 'comprehensive', size: 380, failing: 1, inconclusive: 1, errors: 0, rejected: [] }
    ];
    const report = formatReport(result);
    assert.match(report, /conservative .*inconclusive on 3 of 3 pages/);
    assert.doesNotMatch(report, /looks the same/);
    assert.match(report, /comprehensive .*looks different on 1 of 3 pages, inconclusive on 1/);
  });

  test('Says how far presets move elements, where that is all that differs', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 });
    result.presets = [{ name: 'comprehensive', size: 380, failing: 1, inconclusive: 0, errors: 0, rejected: [], shift: 10 }];
    assert.match(formatReport(result), /comprehensive +380 B +5\.0% smaller +looks different on 1 of 1 page \(moves elements by up to 10 px\)/);
  });
});

describe('`toPresetConfig`', () => {
  test('Expresses the configuration as the nearest preset with the same effect', () => {
    const result = resultOf(SIZES);
    result.options = { caseSensitive: true, collapseBooleanAttributes: true, collapseWhitespace: true, removeComments: true, removeDefaultTypeAttributes: true, sortAttributes: true };
    const found = toPresetConfig(result, { fileExt: 'html' });
    assert.strictEqual(found?.name, 'conservative');
    assert.deepStrictEqual(found?.changes, ['conservativeCollapse', 'preserveLineBreaks', 'sortAttributes']);
    assert.deepStrictEqual(found?.config, {
      $schema: 'https://raw.githubusercontent.com/j9t/html-minifier/main/html-minifier.schema.json',
      preset: 'conservative',
      conservativeCollapse: false,
      fileExt: 'html',
      preserveLineBreaks: false,
      sortAttributes: true
    });
  });

  test('Returns nothing where a preset wouldn’t halve the configuration', () => {
    const result = resultOf(SIZES);
    result.options = { collapseWhitespace: true, removeComments: true, sortAttributes: true, sortClassNames: true };
    assert.strictEqual(toPresetConfig(result), null);
  });
});

describe('`formatReport` table', () => {
  test('Names the fallback in use with the option, without a column of its own', () => {
    const report = formatReport(resultOf(SIZES, [
      { name: 'collapseWhitespace', variant: 'conservativeCollapse', savings: 40, contribution: 38 },
      { name: 'removeComments', savings: 10, contribution: 10 }
    ]));
    assert.match(report, /^collapseWhitespace \(conservativeCollapse\) +recommended +40 B +38 B$/m);
    assert.match(report, /^removeComments +recommended +10 B +10 B$/m);
    assert.doesNotMatch(report, /Variant/);
  });

  test('Shows what options save in the configuration only where any do', () => {
    assert.match(formatReport(resultOf(SIZES, [{ savings: 10, contribution: 12 }])), /^Option +Status +Saves alone +Saves in setup$/m);
    const report = formatReport(resultOf(SIZES, [{ status: 'no-gain', savings: 0 }]));
    assert.match(report, /^Option +Status +Saves alone$/m);
    assert.doesNotMatch(report, /Saves in setup/);
  });

  test('Colors recommended and kept options’ statuses green and dims those of options left out for lack of gain, where colored', () => {
    const report = formatReport(resultOf(SIZES, [
      { status: 'accepted', savings: 10, contribution: 10 },
      { status: 'kept', savings: 5, contribution: 5 },
      { status: 'rejected', savings: 5 },
      { status: 'in-effect' },
      { status: 'no-gain' },
      { status: 'no-effect' },
      { status: 'skipped' }
    ]), { color: true });
    for (const status of ['recommended', 'kept']) assert.match(report, new RegExp(`${ESC}\\[32m${status}${ESC}\\[0m`));
    for (const status of ['in effect already', 'no gain', 'no effect', 'skipped']) assert.match(report, new RegExp(`${ESC}\\[2m${status}${ESC}\\[0m`));
    assert.match(report, /option2 +doesn’t fit/);
  });
});

describe('`formatReport` statuses', () => {
  test('Shows statuses in words', () => {
    const report = formatReport(resultOf(SIZES, [{ status: 'no-effect' }, { status: 'no-gain' }, { status: 'accepted' }]));
    assert.match(report, /no effect/);
    assert.match(report, /no gain/);
    assert.match(report, /recommended/);
    assert.doesNotMatch(report, /no-effect|no-gain|accepted/);
    assert.match(formatReport(resultOf(SIZES, [{ status: 'rejected' }])), /doesn’t fit/);
    assert.match(formatReport(resultOf(SIZES, [{ status: 'in-effect' }])), /in effect already/);
  });

  test('Counts options in effect already among those without effect where pages look minified', () => {
    const report = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'in-effect' }, { status: 'no-effect' }, { status: 'accepted' }]));
    assert.match(report, /look minified already: Collapsing whitespace saves less than 1%, and 2 of 3 options change nothing/);
  });

  test('Asks to test the configuration on the site only where there’s one', () => {
    assert.match(formatReport(resultOf(SIZES, [{ status: 'accepted' }])), /not that they never will—test the configuration on your site\.$/);
    assert.match(formatReport(resultOf(SIZES, [{ status: 'no-effect' }])), /not that they never will\.$/);
  });

  test('Leaves options in effect already out of details', () => {
    const report = formatReport(resultOf(SIZES, [{ name: 'removeAttributeQuotes', status: 'in-effect', reasons: [{ level: 'info', page: 'index.html', message: 'What it acts on is in the form it produces already' }] }]));
    assert.doesNotMatch(report, /Details:/);
  });
});

describe('`formatConfiguration`', () => {
  const SCHEMA = '"$schema": "https://raw.githubusercontent.com/j9t/html-minifier/main/html-minifier.schema.json"';

  test('Prints the recommended configuration', () => {
    const result = resultOf(SIZES, [{ name: 'removeComments', options: { removeComments: true } }]);
    result.options = { removeComments: true };
    const text = formatConfiguration(result);
    assert.match(text, /^Recommended configuration:\n\{\n {2}"\$schema": .*,\n {2}"removeComments": true\n\}$/);
    assert.doesNotMatch(text, /in effect already/);
  });

  test('Names options in effect already alongside the recommended configuration', () => {
    const result = resultOf(SIZES, [{ name: 'removeComments', options: { removeComments: true } }, { name: 'useShortDoctype', status: 'in-effect', options: { useShortDoctype: true } }, { name: 'minifyCSS', status: 'in-effect', options: { minifyCSS: true } }]);
    result.options = { removeComments: true };
    const text = formatConfiguration(result);
    assert.match(text, /^Recommended configuration:\n/);
    assert.match(text, /\n\nThese pages have `minifyCSS` and `useShortDoctype` in effect already\. To keep them so \(e\.g\., when switching from another minifier\), add them—as they change nothing here, the checks can’t vouch for them, so check them on pages before minification\.$/);
  });

  test('Says there’s no configuration to recommend instead of printing one without options', () => {
    const result = resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'rejected', savings: 40 }]);
    result.options = { caseSensitive: true };
    const text = formatConfiguration(result, { preserved: { fileExt: 'html' } });
    assert.strictEqual(text, 'No configuration to recommend: The options that save something don’t fit these pages.');
  });

  test('Explains why there’s no configuration to recommend', () => {
    assert.strictEqual(formatConfiguration(resultOf(SIZES, [{ status: 'no-gain' }])), 'No configuration to recommend: No option saves anything on these pages with Gzip.');
    assert.match(formatConfiguration(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'no-effect' }, { status: 'no-effect' }])), /^No configuration to recommend: These pages look minified already\.$/);
  });

  test('Points to `--allow-shift` where options that save something only move elements', () => {
    const reasons = [{ level: /** @type {const} */ ('render'), page: 'a.html', message: 'Moves elements by up to 4 px at 1280×800 (e.g., ul > li)', shift: 4 }, { level: /** @type {const} */ ('render'), page: 'b.html', message: 'Moves elements by up to 10 px at 1280×800 (e.g., ul > li)', shift: 10 }];
    const result = resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'rejected', savings: 40, reasons }]);
    assert.strictEqual(formatConfiguration(result), 'No configuration to recommend: The options that save something only move elements on these pages, by up to 10 px—`--allow-shift 10` accepts that.');
    assert.match(formatReport(result), /collapseWhitespace \(doesn’t fit\)\n {4}Why: .*\n {4}Only moves elements, by up to 10 px—`--allow-shift 10` accepts that\n/);
    const mixed = resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'rejected', savings: 40, reasons: [...reasons, { level: 'render', page: 'c.html', message: 'Looks different at 1280×800' }] }]);
    assert.doesNotMatch(formatReport(mixed), /--allow-shift/);
    assert.strictEqual(formatConfiguration(mixed), 'No configuration to recommend: The options that save something don’t fit these pages.');
  });

  test('Offers no configuration matching the pages where options that save something don’t fit, as it would read as an alternative', () => {
    const result = resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'rejected', savings: 40 }, { name: 'removeAttributeQuotes', status: 'in-effect', options: { removeAttributeQuotes: true } }]);
    assert.strictEqual(toMatchingConfig(result), null);
    assert.strictEqual(formatConfiguration(result), 'No configuration to recommend: The options that save something don’t fit these pages.');
  });

  test('Offers the configuration matching pages that look minified, where nothing is recommended', () => {
    const result = resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'in-effect', options: { collapseWhitespace: true } }, { name: 'removeAttributeQuotes', status: 'in-effect', options: { removeAttributeQuotes: true } }, { status: 'no-effect' }]);
    result.options = { caseSensitive: true };
    const text = formatConfiguration(result, { preserved: { fileExt: 'html' } });
    assert.ok(text.startsWith('No configuration to recommend: These pages look minified already.\n\nConfiguration matching these pages, by the options in effect already (as they change nothing here, the checks can’t vouch for them—check it on pages before minification):\n{\n'), text);
    assert.ok(text.includes(SCHEMA));
    assert.match(text, /"caseSensitive": true,\n {2}"collapseWhitespace": true,\n {2}"fileExt": "html",\n {2}"removeAttributeQuotes": true\n\}$/);
  });

  test('Marks headings in bold, where colored', () => {
    const result = resultOf(SIZES, [{ name: 'removeComments', options: { removeComments: true } }]);
    result.options = { removeComments: true };
    assert.ok(formatConfiguration(result, { color: true }).startsWith(`${ESC}[1mRecommended configuration:`));
  });
});

describe('`toMatchingConfig`', () => {
  test('Adds the options in effect already to the recommended ones, or returns nothing where there are none', () => {
    const result = resultOf(SIZES, [{ name: 'removeComments', options: { removeComments: true } }, { name: 'useShortDoctype', status: 'in-effect', options: { useShortDoctype: true } }]);
    result.options = { removeComments: true };
    assert.deepStrictEqual(Object.keys(toMatchingConfig(result) ?? {}), ['$schema', 'removeComments', 'useShortDoctype']);
    assert.strictEqual(toMatchingConfig(resultOf(SIZES, [{ status: 'no-effect' }])), null);
  });
});

describe('`hasRecommendation`', () => {
  test('Tells whether any option is recommended or kept, not counting carried options', () => {
    const result = resultOf(SIZES, [{ status: 'no-effect' }]);
    result.options = { caseSensitive: true };
    assert.strictEqual(hasRecommendation(result), false);
    assert.strictEqual(hasRecommendation(resultOf(SIZES, [{ status: 'kept' }])), true);
  });
});

describe('`formatReport` details', () => {
  /** @type {import('../src/select.js').Reason[]} */
  const reasons = [
    { level: 'render', page: 'a.html', message: 'Text differs at 1280×800: line breaks or spacing changed' },
    { level: 'render', page: 'b.html', message: 'Looks different at 1280×800' },
    { level: 'render', page: 'b.html', message: 'Text differs at 1280×800: “a  b” became “a b”' },
    { level: 'info', message: 'Falls back to `conservativeCollapse`' },
    { level: 'render', page: 'a.html', message: 'Text differs at 1280×800: line breaks or spacing changed' },
    { level: 'render', page: 'b.html', message: 'Looks different at 390×844' },
    { level: 'risk', page: 'c.html', message: 'Removes a comment' },
    { level: 'risk', page: 'd.html', message: 'Removes a comment' },
    { level: 'risk', page: 'e.html', message: 'Removes a comment' },
    { level: 'risk', page: 'f.html', message: 'Removes a comment' }
  ];

  test('Sums up render differences by pages, with an example, and repeats nothing', () => {
    const report = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'rejected', reasons }]));
    assert.match(report, /Looks different on 2 pages \(a\.html, b\.html\), e\.g\., b\.html: Text differs at 1280×800: “a {2}b” became “a b”/);
    assert.match(report, /Looks different on the same 2 pages/);
    assert.match(report, /Risk \(c\.html, d\.html, e\.html, and 1 more\): Removes a comment/);
    assert.strictEqual(report.match(/Text differs/g)?.length, 1);
    assert.match(report, /-v/);
  });

  test('Gives the largest move as example, where elements move', () => {
    const moves = [4, 231, 11].map((shift, index) => ({ level: /** @type {const} */ ('render'), page: `${index}.html`, message: `Moves elements by up to ${shift} px at 390×844 (e.g., main)`, shift }));
    assert.match(formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'rejected', reasons: moves }])), /e\.g\., 1\.html: Moves elements by up to 231 px/);
  });

  test('Lists options with the same details once, together', () => {
    const reason = { level: /** @type {const} */ ('render'), page: 'a.html', message: 'Looks different at 1280×800' };
    const report = formatReport(resultOf(SIZES, [
      { name: 'removeComments', status: 'rejected', reasons: [reason] },
      { name: 'collapseWhitespace', status: 'rejected', reasons: [reason] },
      { name: 'sortAttributes', status: 'rejected', reasons: [reason] },
      { name: 'decodeEntities', status: 'rejected', reasons: [{ ...reason, page: 'b.html' }] }
    ]));
    assert.match(report, /\n {2}removeComments, sortAttributes \(doesn’t fit\)\n {4}Why: Not meant to change/);
    assert.match(report, /\n {2}collapseWhitespace \(doesn’t fit\)\n {4}Why: Collapses whitespace/);
    assert.match(report, /\n {2}decodeEntities \(doesn’t fit\)\n/);
    assert.strictEqual(report.match(/Looks different on 1 page \(a\.html\)/g)?.length, 2);
  });

  test('Lists every reason if verbose', () => {
    const report = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'rejected', reasons }]), { verbose: true });
    assert.strictEqual(report.match(/Text differs/g)?.length, 3);
    assert.strictEqual(report.match(/Removes a comment/g)?.length, 4);
    assert.match(report, /^ {4}Risk \(c\.html\): Removes a comment$/m);
    assert.match(report, /^ {4}Looks different \(b\.html\): Looks different at 390×844$/m);
  });
});

describe('`formatReport` paths', () => {
  test('Shortens page paths by the directory all pages share, naming it once', () => {
    const result = resultOf(SIZES, [{ status: 'rejected', reasons: [{ level: 'risk', page: 'Security/Faq/a.html', message: 'Removes a comment' }] }]);
    result.pages = ['Security/Faq/a.html', 'Security/Faq/b.html'];
    const report = formatReport(result);
    assert.match(report, /Evaluated 2 pages in Security\/Faq\//);
    assert.match(report, /Risk \(a\.html\): Removes a comment/);
  });

  test('Keeps page paths without a shared directory', () => {
    const result = resultOf(SIZES, [{ status: 'rejected', reasons: [{ level: 'risk', page: 'blog/a.html', message: 'Removes a comment' }] }]);
    result.pages = ['blog/a.html', 'index.html'];
    const report = formatReport(result);
    assert.match(report, /Evaluated 2 pages, judging/);
    assert.match(report, /^• Evaluated 2 pages, judging gains by Gzip size\n• Not render-checked.*\n\n/);
    assert.match(report, /Risk \(blog\/a\.html\): /);
  });
});

describe('`formatReport` rendering', () => {
  test('Says the recommended configuration looks the same, at which viewports', () => {
    const result = resultOf(SIZES);
    Object.assign(result, { rendered: true, renderedSame: true, viewports: ['1280×800', '390×844'], browser: 'Chrome 157' });
    assert.match(formatReport(result), /Render-checked in Chrome 157 at 1280×800 and 390×844: The recommended configuration looks the same as the original pages/);
  });

  test('Explains looking different as how an option works, or as a possible bug', () => {
    const reason = { level: /** @type {const} */ ('render'), page: 'a.html', message: 'Looks different at 1280×800' };
    const report = formatReport(resultOf(SIZES, [
      { name: 'collapseWhitespace', status: 'rejected', reasons: [reason] },
      { name: 'sortAttributes', status: 'rejected', reasons: [reason] }
    ]));
    assert.match(report, /collapseWhitespace \(doesn’t fit\)\n {4}Why: .*whitespace.*—that’s how the option works, not an error/);
    assert.match(report, /sortAttributes \(doesn’t fit\)\n {4}Why: Not meant to change how pages look—possibly an HTML Minifier bug worth reporting/);
  });
});