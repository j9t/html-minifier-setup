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

describe('analyzePage', () => {
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

  test('Collects rules that keep whitespace, except for `pre` and `textarea` elements', async () => {
    const context = await analyze('<style>pre, textarea { white-space: pre } .poem { white-space: pre-line }</style><p style="white-space: break-spaces">', {});
    assert.deepStrictEqual(context.whitespaceRules.map((rule) => rule.text), ['.poem { white-space: pre-line }', '[style] { white-space: break-spaces }']);
  });
});

describe('findHazards', () => {
  test('Asks for a check of whitespace collapsing where CSS keeps whitespace', async () => {
    const context = await analyze('<style>.poem { white-space: pre-line }</style><div class="poem">a\nb</div>');
    assert.strictEqual(levels(findHazards('collapseWhitespace', context, '<div class="poem">a\nb</div>', '<div class="poem">a b</div>'), 'check').length, 1);
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