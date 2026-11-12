import { describe, test } from 'node:test';
import assert from 'node:assert';
import { formatReport, toPresetConfig } from '../src/report.js';

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
  notes: [],
  presets: [],
  renderedSame: false,
  viewports: [],
  browser: null
});

describe('formatReport', () => {
  test('Shows savings in green and growth in red, with a sign', () => {
    const report = formatReport(resultOf({ raw: 900, gzip: 410, brotli: 300 }), { color: true });
    assert.match(report, new RegExp(`Uncompressed: .*${ESC}\\[32m−10\\.0%`));
    assert.match(report, new RegExp(`Gzip: .*${ESC}\\[31m\\+2\\.5%`));
    assert.match(report, /Brotli: .*±0%/);
  });

  test('Uses no escape codes without color', () => {
    const report = formatReport(resultOf({ raw: 900, gzip: 410, brotli: 300 }));
    assert.doesNotMatch(report, new RegExp(ESC));
    assert.match(report, /Gzip: .*\+2\.5%/);
  });

  test('Points out pages that look minified already, by whitespace collapsing saving next to nothing', () => {
    const noEffect = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'no-effect' }, { status: 'no-effect' }, { status: 'accepted' }]));
    assert.match(noEffect, /look minified already: Collapsing whitespace saves less than 1%, and 2 of 3 options have no effect/);
    const little = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'no-gain', savings: 2 }]));
    assert.match(little, /look minified already/);
  });

  test('Doesn’t take options without effect for minification', () => {
    const plain = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'accepted', savings: 40 }, { status: 'no-effect' }, { status: 'no-effect' }, { status: 'no-effect' }]));
    assert.doesNotMatch(plain, /minified already/);
  });

  test('Compares the result with presets', () => {
    const result = resultOf({ raw: 900, gzip: 400, brotli: 300 });
    result.presets = [
      { name: 'conservative', size: 440, failing: 0, errors: 0, rejected: ['removeComments'] },
      { name: 'comprehensive', size: 380, failing: 1, errors: 0, rejected: [] }
    ];
    const report = formatReport(result);
    assert.match(report, /conservative +440 B +10\.0% larger +looks the same; includes removeComments, which doesn’t fit/);
    assert.match(report, /comprehensive +380 B +5\.0% smaller +looks different on 1 of 1 page/);
  });
});

describe('toPresetConfig', () => {
  test('Expresses the configuration as the nearest preset with the same effect', () => {
    const result = resultOf(SIZES);
    result.options = { caseSensitive: true, collapseBooleanAttributes: true, collapseWhitespace: true, removeComments: true, removeDefaultTypeAttributes: true, sortAttributes: true, useShortDoctype: true };
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

describe('formatReport statuses', () => {
  test('Shows statuses in words', () => {
    const report = formatReport(resultOf(SIZES, [{ status: 'no-effect' }, { status: 'no-gain' }, { status: 'accepted' }]));
    assert.match(report, /no effect/);
    assert.match(report, /no gain/);
    assert.match(report, /recommended/);
    assert.doesNotMatch(report, /no-effect|no-gain|accepted/);
    assert.match(formatReport(resultOf(SIZES, [{ status: 'rejected' }])), /doesn’t fit/);
  });
});

describe('formatReport details', () => {
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
    assert.match(report, /looks different · 2 pages \(a\.html, b\.html\), e\.g\., b\.html: Text differs at 1280×800: “a {2}b” became “a b”/);
    assert.match(report, /looks different · same 2 pages/);
    assert.match(report, /risk · c\.html, d\.html, e\.html, and 1 more: Removes a comment/);
    assert.strictEqual(report.match(/Text differs/g)?.length, 1);
    assert.match(report, /-v/);
  });

  test('Lists every reason if verbose', () => {
    const report = formatReport(resultOf(SIZES, [{ name: 'collapseWhitespace', status: 'rejected', reasons }]), { verbose: true });
    assert.strictEqual(report.match(/Text differs/g)?.length, 3);
    assert.strictEqual(report.match(/Removes a comment/g)?.length, 4);
  });
});

describe('formatReport paths', () => {
  test('Shortens page paths by the folder all pages share, naming it once', () => {
    const result = resultOf(SIZES, [{ status: 'rejected', reasons: [{ level: 'risk', page: 'Security/Faq/a.html', message: 'Removes a comment' }] }]);
    result.pages = ['Security/Faq/a.html', 'Security/Faq/b.html'];
    const report = formatReport(result);
    assert.match(report, /Evaluated 2 pages in Security\/Faq\//);
    assert.match(report, /risk · a\.html: Removes a comment/);
  });

  test('Keeps page paths without a shared folder', () => {
    const result = resultOf(SIZES, [{ status: 'rejected', reasons: [{ level: 'risk', page: 'blog/a.html', message: 'Removes a comment' }] }]);
    result.pages = ['blog/a.html', 'index.html'];
    const report = formatReport(result);
    assert.match(report, /Evaluated 2 pages, judging/);
    assert.match(report, /risk · blog\/a\.html: /);
  });
});

describe('formatReport rendering', () => {
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
    assert.match(report, /collapseWhitespace \(doesn’t fit\)\n {4}why: .*whitespace.*—that’s how the option works, not an error/);
    assert.match(report, /sortAttributes \(doesn’t fit\)\n {4}why: Not meant to change how pages look—possibly an HTML Minifier bug worth reporting/);
  });
});