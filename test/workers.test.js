import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { minify } from 'html-minifier';
import { createMinifierPool } from '../src/workers.js';

const PAGE = '<!DOCTYPE html>\n<html>\n\t<head>\n\t\t<style>p { color: red; }</style>\n\t</head>\n\t<body>\n\t\t<!-- Note -->\n\t\t<p class="a  b">Text <?php echo 1; ?></p>\n\t</body>\n</html>';

describe('`createMinifierPool`', () => {
  test('Minifies as HTML Minifier does in-process', async () => {
    const pool = createMinifierPool({ size: 2 });
    try {
      const options = { collapseWhitespace: true, minifyCSS: true, removeComments: true, ignoreCustomFragments: [/<\?[\s\S]*?\?>/] };
      const outputs = await Promise.all([pool.minify(PAGE, options), pool.minify(PAGE, {}), pool.minify(PAGE, options)]);
      assert.deepStrictEqual(outputs, [await minify(PAGE, options), await minify(PAGE, {}), await minify(PAGE, options)]);
    } finally {
      await pool.close();
    }
  });

  test('Rejects with HTML Minifier’s message where minification fails', async () => {
    const pool = createMinifierPool({ size: 1 });
    try {
      const expected = await minify(PAGE, { maxInputLength: 5 }).then(() => null, (err) => err.message);
      assert.ok(expected);
      await assert.rejects(pool.minify(PAGE, { maxInputLength: 5 }), { message: expected });
      // And keeps working
      assert.strictEqual(await pool.minify('<p>a</p>', {}), '<p>a</p>');
    } finally {
      await pool.close();
    }
  });

  test('Minifies in-process with options workers can’t receive, such as functions', async () => {
    const pool = createMinifierPool({ size: 1 });
    try {
      assert.match(await pool.minify(PAGE, { minifyCSS: () => 'MINIFIED' }), /<style>MINIFIED<\/style>/);
    } finally {
      await pool.close();
    }
  });

  test('Lets the process exit while idle', async () => {
    const script = `import { createMinifierPool } from ${JSON.stringify(new URL('../src/workers.js', import.meta.url).href)};
const pool = createMinifierPool({ size: 2 });
console.log(await pool.minify('<p>a</p>', { collapseWhitespace: true }));`;
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script]);
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      const timer = setTimeout(() => child.kill(), 10000);
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ code: exitCode, stdout: out, stderr: err });
      });
    });
    assert.strictEqual(code, 0, stderr);
    assert.strictEqual(stdout.trim(), '<p>a</p>');
  });
});