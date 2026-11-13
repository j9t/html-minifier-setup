import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirTest = path.dirname(fileURLToPath(import.meta.url));
const dirSite = path.join(dirTest, 'fixtures', 'site');
const fileCli = path.join(dirTest, '..', 'cli.js');

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
const run = (args, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, [fileCli, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

/**
 * Runs `fn` in a temporary directory holding the given files
 * @param {Record<string, string>} files
 * @param {(dir: string) => Promise<void>} fn
 */
async function inDir(files, fn) {
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-cli-')));
  try {
    for (const [name, content] of Object.entries(files)) await fs.promises.writeFile(path.join(dir, name), content);
    await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

const PAGE = '<!DOCTYPE html>\n<html>\n\t<body>\n\t\t<!-- Note -->\n\t\t<p class="a">Text</p>\n\t</body>\n</html>';
const FLAGS = ['--no-render', '--no-equivalence'];

describe('CLI', () => {
  test('Prints a report and the configuration', async () => {
    const { code, stdout, stderr } = await run([dirSite, '--no-render', '--no-equivalence']);
    assert.strictEqual(code, 0, stderr);
    assert.match(stdout, /collapseWhitespace/);
    assert.match(stdout, /doesn’t fit/);
    assert.match(stdout, /"\$schema"/);
    assert.match(stdout, /not render-checked/i);
    assert.match(stdout, /Recommended configuration:/);
  });

  test('Writes the configuration to a file', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-cli-'));
    try {
      const file = path.join(dir, 'html-minifier.config.json');
      const { code, stderr } = await run([path.join(dirSite, 'index.html'), '--no-render', '--no-equivalence', '-o', file]);
      assert.strictEqual(code, 0, stderr);
      const config = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      assert.strictEqual(config.collapseWhitespace, true);
      assert.match(config.$schema, /html-minifier\.schema\.json$/);
      assert.deepStrictEqual(Object.keys(config).slice(1), Object.keys(config).slice(1).sort());
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test('Prints the full result as JSON', async () => {
    const { code, stdout, stderr } = await run([path.join(dirSite, 'index.html'), '--no-render', '--no-equivalence', '--json']);
    assert.strictEqual(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.strictEqual(result.metric, 'gzip');
    assert.ok(Array.isArray(result.evaluations));
    assert.deepStrictEqual(result.pages, ['index.html']);
  });

  test('Starts from a given configuration', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-cli-'));
    try {
      const file = path.join(dir, 'start.json');
      await fs.promises.writeFile(file, JSON.stringify({ caseSensitive: true, collapseWhitespace: false }));
      const { code, stdout, stderr } = await run([path.join(dirSite, 'index.html'), '--no-render', '--no-equivalence', '--json', '-c', file]);
      assert.strictEqual(code, 0, stderr);
      assert.strictEqual(JSON.parse(stdout).options.caseSensitive, true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  test('Reads html-minifier.config.json from the working directory', async () => {
    await inDir({ 'html-minifier.config.json': JSON.stringify({ caseSensitive: true }), 'index.html': PAGE }, async (dir) => {
      const { code, stdout, stderr } = await run([...FLAGS, '--json'], dir);
      assert.strictEqual(code, 0, stderr);
      assert.match(stderr, /Using config file html-minifier\.config\.json/);
      assert.strictEqual(JSON.parse(stdout).options.caseSensitive, true);
    });
  });

  test('Reads configurations as HTML Minifier does, with a byte order mark or without an extension', async () => {
    await inDir({ 'bom.json': `\uFEFF${JSON.stringify({ caseSensitive: true })}`, 'start': JSON.stringify({ continueOnParseError: true }), 'index.html': PAGE }, async (dir) => {
      for (const [file, name] of [['bom.json', 'caseSensitive'], ['start', 'continueOnParseError']]) {
        const { code, stdout, stderr } = await run([...FLAGS, '--json', '-c', file], dir);
        assert.strictEqual(code, 0, stderr);
        assert.strictEqual(JSON.parse(stdout).options[name], true);
      }
    });
  });

  test('Doesn’t introduce itself where STDERR isn’t a terminal', async () => {
    const { code, stderr } = await run([path.join(dirSite, 'index.html'), ...FLAGS]);
    assert.strictEqual(code, 0, stderr);
    assert.doesNotMatch(stderr, /This is HTML Minifier Setup/);
  });

  test('Prefers a given configuration over html-minifier.config.json', async () => {
    await inDir({ 'html-minifier.config.json': JSON.stringify({ caseSensitive: true }), 'start.json': JSON.stringify({ continueOnParseError: true }), 'index.html': PAGE }, async (dir) => {
      const { code, stdout, stderr } = await run([...FLAGS, '--json', '-c', 'start.json'], dir);
      assert.strictEqual(code, 0, stderr);
      assert.doesNotMatch(stderr, /html-minifier\.config\.json/);
      const { options } = JSON.parse(stdout);
      assert.strictEqual(options.continueOnParseError, true);
      assert.ok(!('caseSensitive' in options));
    });
  });

  test('Writes html-minifier.config.json where no file is named, keeping CLI settings', async () => {
    await inDir({ 'html-minifier.config.json': JSON.stringify({ fileExt: 'html,php', removeComments: false }), 'index.html': PAGE }, async (dir) => {
      const { code, stdout, stderr } = await run([...FLAGS, '-o'], dir);
      assert.strictEqual(code, 0, stderr);
      assert.match(stdout, /Wrote html-minifier\.config\.json/);
      const config = JSON.parse(await fs.promises.readFile(path.join(dir, 'html-minifier.config.json'), 'utf8'));
      assert.strictEqual(config.fileExt, 'html,php');
      assert.strictEqual(config.removeComments, true);
    });
  });

  test('Reads directories by the configuration’s file extensions and ignored directories', async () => {
    await inDir({ 'html-minifier.config.json': JSON.stringify({ fileExt: 'php', ignoreDir: 'skip' }), 'index.php': PAGE, 'index.html': PAGE }, async (dir) => {
      await fs.promises.mkdir(path.join(dir, 'skip'));
      await fs.promises.writeFile(path.join(dir, 'skip', 'other.php'), PAGE);
      const { code, stdout, stderr } = await run([...FLAGS, '--json'], dir);
      assert.strictEqual(code, 0, stderr);
      assert.deepStrictEqual(JSON.parse(stdout).pages, ['index.php']);
    });
  });

  test('Prefers CLI file extensions over the configuration’s', async () => {
    await inDir({ 'html-minifier.config.json': JSON.stringify({ fileExt: 'php' }), 'index.php': PAGE, 'index.html': PAGE }, async (dir) => {
      const { code, stdout, stderr } = await run([...FLAGS, '--json', '--file-ext', 'html'], dir);
      assert.strictEqual(code, 0, stderr);
      assert.deepStrictEqual(JSON.parse(stdout).pages, ['index.html']);
    });
  });

  test('Fails on unknown options to keep or skip', async () => {
    const { code, stderr } = await run([dirSite, '--no-render', '--skip', 'collapseEverything']);
    assert.strictEqual(code, 1);
    assert.match(stderr, /collapseEverything/);
  });

  test('Fails on unknown options to keep or skip before starting the browser', async () => {
    const { code, stderr } = await run([dirSite, '-v', '--keep', 'collapseEverything']);
    assert.strictEqual(code, 1);
    assert.match(stderr, /collapseEverything/);
    assert.doesNotMatch(stderr, /Starting browser/);
  });

  test('Leaves development settings out of its help', async () => {
    const { code, stdout } = await run(['--help']);
    assert.strictEqual(code, 0);
    assert.match(stdout, /--no-presets/);
    assert.doesNotMatch(stdout, /equivalence/);
  });

  test('Fails on missing or empty viewports', async () => {
    for (const value of ['', '0x800', '1280x0']) {
      const { code, stderr } = await run([dirSite, '--viewports', value]);
      assert.strictEqual(code, 1, value);
      assert.match(stderr, /viewport/i, value);
    }
  });

  test('Lists files the render check didn’t get past symbolic links outside the site, unless asked to follow them', async (t) => {
    await inDir({ 'index.html': '<!doctype html><link rel=stylesheet href=site.css><p>a</p>' }, async (dir) => {
      try {
        await fs.promises.symlink(path.join(dirSite, 'css', 'site.css'), path.join(dir, 'site.css'));
      } catch (err) {
        t.skip(`No symbolic links: ${err instanceof Error ? err.message : err}`);
        return;
      }
      const blocked = JSON.parse((await run([dir, '--no-equivalence', '--no-presets', '--json'], dir)).stdout);
      if (!blocked.rendered) {
        t.skip('No browser');
        return;
      }
      assert.deepStrictEqual(blocked.blocked, ['site.css']);
      const followed = JSON.parse((await run([dir, '--no-equivalence', '--no-presets', '--json', '--follow-links'], dir)).stdout);
      assert.deepStrictEqual(followed.blocked, []);
    });
  });

  test('Fails on inputs without pages', async () => {
    const { code, stderr } = await run([path.join(dirSite, 'css'), '--no-render']);
    assert.strictEqual(code, 1);
    assert.match(stderr, /No pages/);
  });
});