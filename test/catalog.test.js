import { describe, test } from 'node:test';
import assert from 'node:assert';
import { CANDIDATES, CARRIED, EXCLUDED, FALLBACKS, MODIFIERS, PRESERVED, readSchema, splitConfig, unclassified } from '../src/catalog.js';
const names = CANDIDATES.map((candidate) => candidate.name);

describe('catalog', () => {
  test('Classifies every option of the installed HTML Minifier', () => {
    const schema = readSchema();
    assert.ok(schema && schema.options.length > 0);
    assert.deepStrictEqual(unclassified(schema.options), [], 'New options need a place in src/catalog.js');
  });

  test('Lists options it doesn’t classify', () => {
    assert.deepStrictEqual(unclassified(['collapseWhitespace', 'newOption', 'fileExt']), ['newOption']);
  });

  test('Classifies no option twice', () => {
    const all = [...names, ...MODIFIERS, ...CARRIED, ...PRESERVED, ...Object.keys(EXCLUDED)];
    assert.strictEqual(new Set(all).size, all.length);
  });

  test('Names only existing candidates as requirements', () => {
    for (const candidate of CANDIDATES) {
      if (candidate.requires) assert.ok(names.includes(candidate.requires), candidate.name);
    }
  });

  test('Lists requirements before what requires them', () => {
    CANDIDATES.forEach((candidate, index) => {
      if (candidate.requires) assert.ok(names.indexOf(candidate.requires) < index, candidate.name);
    });
  });

  test('Offers fallbacks only for candidates, each setting the candidate itself', () => {
    for (const [name, variants] of Object.entries(FALLBACKS)) {
      assert.ok(names.includes(name));
      for (const variant of variants) assert.ok(name in variant.options);
    }
  });
});

describe('splitConfig', () => {
  test('Carries input handling options, takes candidate values, keeps CLI settings, and drops the rest', () => {
    const { base, values, preserved, ignored } = splitConfig({
      $schema: 'x',
      caseSensitive: true,
      ignoreCustomFragments: ['<\\?[\\s\\S]*?\\?>'],
      minifyJS: { engine: 'swc' },
      collapseWhitespace: false,
      preset: 'comprehensive',
      cacheCSS: 10,
      fileExt: 'html,php'
    });
    assert.deepStrictEqual(base, { caseSensitive: true, ignoreCustomFragments: ['<\\?[\\s\\S]*?\\?>'] });
    assert.deepStrictEqual(values, { minifyJS: { engine: 'swc' } });
    assert.deepStrictEqual(preserved, { cacheCSS: 10, fileExt: 'html,php' });
    assert.deepStrictEqual(ignored.sort(), ['$schema', 'collapseWhitespace', 'preset']);
  });
});