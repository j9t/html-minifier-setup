import { describe, test } from 'node:test';
import assert from 'node:assert';
import { minify } from 'html-minifier';
import { TRACED, tracesOf } from '../src/traces.js';

/**
 * @param {string} html
 * @param {string} name
 */
const traced = (html, name) => tracesOf(html).has(name);

const SOURCE = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<style>\n  p { color: red }\n</style>\n<p class=" a  b " title="x" onclick="go( 1 )">Text &ldquo;quoted&rdquo;</p>\n<input disabled="disabled"><img alt="">\n<svg><path d="M0 0"></path></svg>\n<script>\n  go( 1 );\n</script>\n<script type="application/ld+json">\n{ "a": 1 }\n</script>';

describe('`tracesOf`', () => {
  test('Finds no traces on pages before minification', () => {
    assert.deepStrictEqual([...tracesOf(SOURCE)], []);
  });

  test('Finds traces of each option in its output', async () => {
    for (const name of TRACED) {
      const output = await minify(SOURCE, { [name]: true });
      assert.ok(traced(output, name), `${name}: ${output}`);
    }
  });

  test('Finds nothing on pages without what options act on', () => {
    assert.deepStrictEqual([...tracesOf('<p>')], []);
  });

  test('Takes nothing for traces where some of it isn’t in the form options produce', () => {
    assert.ok(!traced('<p title=x>a</p><p title="y">b</p>', 'removeAttributeQuotes'));
    assert.ok(traced('<p title=x>a</p><p title="y z">b</p>', 'removeAttributeQuotes'));
    assert.ok(!traced('<p class="a b"></p><p class=" c">', 'collapseAttributeWhitespace'));
    assert.ok(!traced('<p>a b</p><p>c  d</p>', 'collapseWhitespace'));
    assert.ok(!traced('<p>“a” &amp; &ldquo;b&rdquo;</p>', 'decodeEntities'));
  });

  test('Ignores whitespace in preformatted text, scripts, and styles', () => {
    assert.ok(traced('<p>a b</p><pre>  c\n</pre><script>\n</script>', 'collapseWhitespace'));
  });

  test('Takes self-closed elements for traces only in SVG and MathML', () => {
    assert.ok(!traced('<p>a<br/>b</p>', 'selfCloseForeignElements'));
    assert.ok(traced('<math><mspace/></math>', 'selfCloseForeignElements'));
  });

  test('Takes JSON scripts for traces of `minifyJSON`, not of `minifyJS`', () => {
    const html = '<script type="importmap">{"imports":{}}</script>';
    assert.ok(traced(html, 'minifyJSON'));
    assert.ok(!traced(html, 'minifyJS'));
  });

  test('Takes only bare boolean attributes for traces of `collapseBooleanAttributes`, and other bare ones for `collapseEmptyAttributes`', () => {
    assert.deepStrictEqual([...tracesOf('<input disabled>')].filter((name) => name.startsWith('collapse') && name.endsWith('Attributes')), ['collapseBooleanAttributes']);
    assert.deepStrictEqual([...tracesOf('<img alt>')].filter((name) => name.startsWith('collapse') && name.endsWith('Attributes')), ['collapseEmptyAttributes']);
  });
});