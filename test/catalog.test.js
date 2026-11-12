import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { CANDIDATES, CARRIED, EXCLUDED, FALLBACKS, MODIFIERS, PRESERVED, splitConfig } from '../src/catalog.js';

const schema = JSON.parse(fs.readFileSync(new URL('html-minifier.schema.json', import.meta.resolve('html-minifier/package.json')), 'utf8'));
const names = CANDIDATES.map((candidate) => candidate.name);

describe('catalog', () => {
  test('Classifies every option of the installed HTML Minifier', () => {
    const classified = new Set([...names, ...MODIFIERS, ...CARRIED, ...PRESERVED, ...Object.keys(EXCLUDED)]);
    const unclassified = Object.keys(schema.properties).filter((name) => !classified.has(name));
    assert.deepStrictEqual(unclassified, [], 'New options need a place in src/catalog.js');
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