import { describe, test } from 'node:test';
import assert from 'node:assert';
import { analyzePage, findHazards } from '../src/hazards.js';
import { createPage } from '../src/pages.js';

/**
 * @param {string} html
 * @param {Record<string, string>} [files]
 */
const analyze = (html, files = {}) => analyzePage(createPage({ id: 'test.html', html, resources: files }));

/**
 * @param {import('../src/hazards.js').Hazard[]} hazards
 * @param {string} level
 */
const levels = (hazards, level) => hazards.filter((hazard) => hazard.level === level);

describe('`analyzePage`', () => {
  test('Collects strings from inline and linked scripts, and notes scripts it can’t read', async () => {
    const context = await analyze('<script>x("is-open")</script><script src="a.js"></script><script src="https://cdn.example/b.js"></script><button onclick="y(\'on-click\')">', { 'a.js': 'z(`from-file`)' });
    assert.ok(context.scriptStrings.has('is-open'));
    assert.ok(context.scriptStrings.has('from-file'));
    assert.ok(context.scriptStrings.has('on-click'));
    assert.deepStrictEqual(context.scriptsUnread, ['https://cdn.example/b.js']);
  });

  test('Collects attribute references from style sheets and scripts', async () => {
    const context = await analyze('<link rel="stylesheet" href="a.css"><style>[data-x] {}</style><script>el.getAttribute("method"); q("[type=text]")</script>', { 'a.css': 'input[ type = "text" ] {}' });
    assert.deepStrictEqual([...context.attributeRefs].sort(), ['data-x', 'method', 'type']);
  });

  test('Collects style sheets that style sheets import, relative to the importing sheet', async () => {
    const context = await analyze('<link rel="stylesheet" href="css/a.css"><style>@import "/inline.css";</style>', {
      'css/a.css': '/* @import "skipped.css"; */ @import "b.css" screen; @import url(\'/c.css\');',
      '/css/b.css': '.poem { white-space: pre-line } @import "a.css";',
      '/css/a.css': '@import url(b.css);',
      '/c.css': '[data-c] {}',
      '/inline.css': '[data-inline] {}'
    });
    assert.deepStrictEqual(context.whitespaceRules.map((rule) => rule.text), ['.poem { white-space: pre-line }']);
    assert.deepStrictEqual([...context.attributeRefs].sort(), ['data-c', 'data-inline']);
  });

  test('Resolves imports relative to where a redirected style sheet ends', async () => {
    const page = createPage({ id: 'test.html', html: '<link rel="stylesheet" href="style.css">', resources: { '/v2/b.css': '.poem { white-space: pre-line }' } });
    const load = page.load;
    page.load = async (ref) => ref === 'style.css' ? { text: '@import "b.css";', ref: '/v2/style.css' } : load(ref);
    const context = await analyzePage(page);
    assert.deepStrictEqual(context.whitespaceRules.map((rule) => rule.text), ['.poem { white-space: pre-line }']);
  });

  test('Skips imports it can’t resolve, collecting the others', async () => {
    const context = await analyze('<link rel="stylesheet" href="a.css">', { 'a.css': '@import "http://[x"; @import "b.css";', '/b.css': '[data-b] {}' });
    assert.deepStrictEqual([...context.attributeRefs], ['data-b']);
  });

  test('Keeps statements with quoted semicolons and braces out of selectors', async () => {
    const context = await analyze(`<style>@import url("a;b{c.css") screen; @namespace x 'd\\'e;'; @charset "f\\";g"; .poem { white-space: pre-line }</style>`);
    assert.deepStrictEqual(context.whitespaceRules.map((rule) => rule.text), ['.poem { white-space: pre-line }']);
  });

  test('Collects rules that keep whitespace, except for `pre` and `textarea` elements', async () => {
    const context = await analyze('<style>@charset "utf-8"; pre, textarea { white-space: pre } /* Verse */ .poem { white-space: pre-line }</style><p style="white-space: break-spaces">', {});
    assert.deepStrictEqual(context.whitespaceRules.map((rule) => rule.text), ['.poem { white-space: pre-line }', '[style] { white-space: break-spaces }']);
  });
});

describe('`findHazards`', () => {
  test('Asks for a check of whitespace collapsing where CSS keeps whitespace', async () => {
    const context = await analyze('<style>.poem { white-space: pre-line }</style><div class="poem">a\nb</div>');
    assert.strictEqual(levels(findHazards('collapseWhitespace', context, '<div class="poem">a\nb</div>', '<div class="poem">a b</div>'), 'check').length, 1);
  });

  test('Matches whitespace rules by the selector outside nested parentheses', async () => {
    const context = await analyze('<style>div:has(> .poem:not(.x)) { white-space: pre-line }</style>');
    assert.strictEqual(levels(findHazards('collapseWhitespace', context, '<div><p>a\nb</p></div>', '<div><p>a b</p></div>'), 'check').length, 1);
  });

  test('Finds no whitespace hazard where no element matches the rule', async () => {
    const context = await analyze('<style>.poem { white-space: pre-line }</style>');
    assert.deepStrictEqual(findHazards('collapseWhitespace', context, '<p class="prose">a\nb</p>', '<p class="prose">a b</p>'), []);
  });

  test('Finds no whitespace hazard where output is unchanged', async () => {
    const context = await analyze('<style>.poem { white-space: pre-line }</style>');
    assert.deepStrictEqual(findHazards('collapseWhitespace', context, '<p>a', '<p>a'), []);
  });

  test('Flags removed comments that look meaningful', async () => {
    const context = await analyze('');
    const hazards = findHazards('removeComments', context, '<!-- ko text: a --><!-- /ko --><!-- plain -->', '');
    assert.strictEqual(levels(hazards, 'risk').length, 2);
    assert.match(hazards[0]?.message ?? '', /Knockout/);
  });

  test('Only notes removed conditional comments, which only old Internet Explorer reads', async () => {
    const context = await analyze('');
    const hazards = findHazards('removeComments', context, '<!--[if lt IE 9]><script src="a.js"></script><![endif]-->', '');
    assert.deepStrictEqual(hazards.map((hazard) => hazard.level), ['note']);
  });

  test('Flags removed comments where scripts read comments', async () => {
    const context = await analyze('<script>walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT)</script>');
    assert.strictEqual(levels(findHazards('removeComments', context, '<!-- data -->', ''), 'risk').length, 1);
  });

  test('Flags removed empty elements whose class scripts name', async () => {
    const context = await analyze('<script>document.querySelector(".slot")</script>');
    const hazards = findHazards('removeEmptyElements', context, '<div class="slot"></div><span class="other"></span>', '');
    assert.strictEqual(levels(hazards, 'risk').length, 1);
    assert.match(hazards[0]?.message ?? '', /slot/);
  });

  test('Flags style rules removed for classes that scripts name', async () => {
    const context = await analyze('', {});
    context.scriptStrings.add('is-open');
    const hazards = findHazards('removeUnusedCSS', context, '<style>.is-open{color:red}.gone{color:red}</style>', '<style></style>');
    assert.strictEqual(levels(hazards, 'risk').length, 1);
    assert.match(hazards[0]?.message ?? '', /is-open/);
  });

  test('Notes removed style rules where scripts can’t be read', async () => {
    const context = await analyze('<script src="https://cdn.example/a.js"></script>');
    assert.strictEqual(levels(findHazards('removeUnusedCSS', context, '<style>.a{color:red}</style>', '<style></style>'), 'note').length, 1);
  });

  test('Flags attributes changed that style sheets or scripts select on', async () => {
    const context = await analyze('<link rel="stylesheet" href="a.css">', { 'a.css': 'input[type="text"] {}' });
    const hazards = findHazards('removeRedundantAttributes', context, '<input type="text"><form method="get">', '<input><form>');
    assert.strictEqual(levels(hazards, 'risk').length, 1);
    assert.match(hazards[0]?.message ?? '', /`type`/);
  });

  test('Flags reordered classes where CSS matches class prefixes', async () => {
    const context = await analyze('<style>[class^="icon-"] {}</style>');
    assert.strictEqual(levels(findHazards('sortClassNames', context, '<i class="icon-a b">', '<i class="b icon-a">'), 'risk').length, 1);
  });

  test('Ignores attribute changes for options that keep the DOM the same', async () => {
    const context = await analyze('<style>[type] {}</style>');
    assert.deepStrictEqual(findHazards('removeAttributeQuotes', context, '<input type="text">', '<input type=text>'), []);
  });

  test('Asks for a check where the doctype switches the document mode', async () => {
    const context = await analyze('<p>x');
    const quirks = findHazards('useShortDoctype', context, '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><p>x', '<!doctype html><p>x');
    assert.match(levels(quirks, 'check')[0]?.message ?? '', /from quirks mode to standards mode/);
    const almost = findHazards('useShortDoctype', context, '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><p>x', '<!doctype html><p>x');
    assert.match(levels(almost, 'check')[0]?.message ?? '', /from almost standards mode to standards mode/);
    const strict = findHazards('useShortDoctype', context, '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><p>x', '<!doctype html><p>x');
    assert.strictEqual(strict.length, 0);
  });
});