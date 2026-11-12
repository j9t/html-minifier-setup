import { describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPackageManager, fetchLatestVersion, findPackage, isNewer, offerSetup, projectOf } from '../src/setup.js';

const CONFIG = { $schema: 'https://example.com/schema.json', collapseWhitespace: true };

/**
 * Runs `fn` in a temporary directory holding the given files
 * @param {Record<string, string>} files
 * @param {(dir: string) => Promise<void>} fn
 */
async function inDir(files, fn) {
  const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hms-setup-')));
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.promises.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.promises.writeFile(path.join(dir, name), content);
    }
    await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Answers prompts in order, recording the questions
 * @param {string[]} answers
 */
const scripted = (answers) => {
  const questions = /** @type {string[]} */ ([]);
  return {
    questions,
    /** @param {string} question */
    async ask(question) {
      questions.push(question);
      return answers.shift() ?? '';
    }
  };
};

/** Records installs */
const fakeInstall = () => {
  const calls = /** @type {{dir: string, manager: string}[]} */ ([]);
  return {
    calls,
    /** @param {string} dir @param {string} manager */
    async install(dir, manager) {
      calls.push({ dir, manager });
      return true;
    }
  };
};

const PACKAGE_HM = JSON.stringify({ name: 'html-minifier', version: '5.1.0' });

describe('findPackage', () => {
  test('Finds a package in node_modules of the directory or above', async () => {
    await inDir({ 'node_modules/html-minifier/package.json': PACKAGE_HM, 'site/dist/index.html': '' }, async (dir) => {
      assert.strictEqual(findPackage('html-minifier', path.join(dir, 'site', 'dist'))?.version, '5.1.0');
      assert.strictEqual(findPackage('other', dir), null);
    });
  });
});

describe('detectPackageManager', () => {
  test('Detects the package manager by lockfile, defaulting to npm', async () => {
    await inDir({ 'pnpm-lock.yaml': '', 'site/index.html': '' }, async (dir) => {
      assert.strictEqual(detectPackageManager(path.join(dir, 'site')), 'pnpm');
    });
    await inDir({ 'index.html': '' }, async (dir) => {
      assert.strictEqual(detectPackageManager(dir), 'npm');
    });
  });

  test('Detects the package manager a package.json declares, after lockfiles', async () => {
    await inDir({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0' }), 'site/index.html': '' }, async (dir) => {
      assert.strictEqual(detectPackageManager(path.join(dir, 'site')), 'pnpm');
    });
    await inDir({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.0.0' }), 'bun.lock': '' }, async (dir) => {
      assert.strictEqual(detectPackageManager(dir), 'bun');
    });
    await inDir({ 'package.json': JSON.stringify({ packageManager: 'unknown@1.0.0' }) }, async (dir) => {
      assert.strictEqual(detectPackageManager(dir), 'npm');
    });
  });
});

describe('fetchLatestVersion', () => {
  test('Returns the latest version from the registry', async () => {
    /** @type {string[]} */
    const urls = [];
    const fetch = async (/** @type {string} */ url) => {
      urls.push(url);
      return /** @type {Response} */ (/** @type {unknown} */ ({ ok: true, json: async () => ({ version: '5.2.0' }) }));
    };
    assert.strictEqual(await fetchLatestVersion('html-minifier', { fetch, registry: 'https://registry.example.com/' }), '5.2.0');
    assert.deepStrictEqual(urls, ['https://registry.example.com/html-minifier/latest']);
  });

  test('Returns null where the registry fails or can’t be reached', async () => {
    const failing = async () => /** @type {Response} */ (/** @type {unknown} */ ({ ok: false, json: async () => ({}) }));
    assert.strictEqual(await fetchLatestVersion('html-minifier', { fetch: failing }), null);
    const unreachable = async () => { throw new Error('Offline'); };
    assert.strictEqual(await fetchLatestVersion('html-minifier', { fetch: unreachable }), null);
  });
});

describe('isNewer', () => {
  test('Compares versions numerically', () => {
    assert.strictEqual(isNewer('5.10.0', '5.9.1'), true);
    assert.strictEqual(isNewer('5.1.0', '5.1.0'), false);
    assert.strictEqual(isNewer('4.9.9', '5.0.0'), false);
  });

  test('Ranks releases above their prereleases, and prereleases by identifier', () => {
    assert.strictEqual(isNewer('5.2.0', '5.2.0-rc.1'), true);
    assert.strictEqual(isNewer('5.2.0-rc.1', '5.2.0'), false);
    assert.strictEqual(isNewer('5.2.0-rc.10', '5.2.0-rc.9'), true);
    assert.strictEqual(isNewer('5.2.0-beta', '5.2.0-alpha.1'), true);
    assert.strictEqual(isNewer('5.2.0-alpha.1', '5.2.0-alpha'), true);
    assert.strictEqual(isNewer('5.2.0-alpha.1', '5.2.0-alpha.beta'), false);
    assert.strictEqual(isNewer('5.2.0+build.2', '5.2.0+build.1'), false);
  });
});

describe('projectOf', () => {
  test('Returns the project of the first local input', async () => {
    await inDir({ 'site/package.json': '{}', 'site/dist/index.html': '' }, async (dir) => {
      const dirSite = path.join(dir, 'site');
      assert.strictEqual(projectOf(['https://example.com/', 'site/dist'], dir), dirSite);
      assert.strictEqual(projectOf(['site/dist/index.html'], dir), dirSite);
    });
  });

  test('Doesn’t look for a project beyond the repository of the input', async () => {
    await inDir({ 'package.json': '{}', 'site/.git/HEAD': '', 'site/index.html': '' }, async (dir) => {
      assert.strictEqual(projectOf(['site'], dir), path.join(dir, 'site'));
    });
  });

  test('Falls back to the input folder outside projects and repositories', async () => {
    await inDir({ 'site/index.html': '' }, async (dir) => {
      const found = projectOf(['site'], dir);
      assert.ok(found === path.join(dir, 'site') || !found.startsWith(dir), found);
    });
  });

  test('Returns the working directory for URLs only', () => {
    assert.strictEqual(projectOf(['https://example.com/'], '/somewhere'), '/somewhere');
  });
});

describe('offerSetup', () => {
  test('Does nothing where both offers are declined by default', async () => {
    await inDir({}, async (dir) => {
      const { ask, questions } = scripted([]);
      const { install, calls } = fakeInstall();
      await offerSetup({ config: CONFIG, cwd: dir, ask, install, log() {} });
      assert.deepStrictEqual(questions.map((question) => question.split('?')[0]), ['Save configuration file', 'Install HTML Minifier']);
      assert.deepStrictEqual(fs.readdirSync(dir), []);
      assert.deepStrictEqual(calls, []);
    });
  });

  test('Saves the configuration to the current folder by default', async () => {
    await inDir({}, async (dir) => {
      const { ask } = scripted(['y', '', 'n']);
      await offerSetup({ config: CONFIG, cwd: dir, ask, install: fakeInstall().install, log() {} });
      const config = JSON.parse(await fs.promises.readFile(path.join(dir, 'html-minifier.config.json'), 'utf8'));
      assert.deepStrictEqual(config, CONFIG);
    });
  });

  test('Saves the configuration to a given folder, creating it', async () => {
    await inDir({}, async (dir) => {
      const { ask } = scripted(['yes', 'site', 'n']);
      await offerSetup({ config: CONFIG, cwd: dir, ask, install: fakeInstall().install, log() {} });
      assert.ok(fs.existsSync(path.join(dir, 'site', 'html-minifier.config.json')));
    });
  });

  test('Overwrites an existing configuration only if confirmed', async () => {
    await inDir({ 'html-minifier.config.json': '{}' }, async (dir) => {
      const { ask, questions } = scripted(['y', '', '', 'n']);
      await offerSetup({ config: CONFIG, cwd: dir, ask, install: fakeInstall().install, log() {} });
      assert.match(questions[2] ?? '', /Overwrite/);
      assert.strictEqual(await fs.promises.readFile(path.join(dir, 'html-minifier.config.json'), 'utf8'), '{}');
    });
  });

  test('Doesn’t offer to install HTML Minifier where it is installed', async () => {
    await inDir({ 'node_modules/html-minifier/package.json': PACKAGE_HM }, async (dir) => {
      const { ask, questions } = scripted([]);
      const logged = /** @type {string[]} */ ([]);
      await offerSetup({ config: CONFIG, cwd: dir, ask, install: fakeInstall().install, log: (message) => logged.push(message) });
      assert.strictEqual(questions.length, 1);
      assert.match(logged.join('\n'), /HTML Minifier 5\.1\.0 is installed/);
    });
  });

  test('Installs HTML Minifier in the project folder by default, with its package manager', async () => {
    await inDir({ 'package.json': '{}', 'yarn.lock': '', 'site/index.html': '' }, async (dir) => {
      const { ask, questions } = scripted(['y', 'site', 'y', '']);
      const { install, calls } = fakeInstall();
      await offerSetup({ config: CONFIG, cwd: dir, ask, install, log() {} });
      assert.match(questions[3] ?? '', /current folder/);
      assert.deepStrictEqual(calls, [{ dir, manager: 'yarn' }]);
    });
  });

  test('Offers to save the configuration as the nearest preset', async () => {
    await inDir({}, async (dir) => {
      const configPreset = { name: 'conservative', changes: ['sortAttributes'], config: { preset: 'conservative', sortAttributes: true } };
      const { ask, questions } = scripted(['y', '', 'y', 'n']);
      await offerSetup({ config: CONFIG, configPreset, cwd: dir, ask, install: fakeInstall().install, log() {} });
      assert.match(questions[2] ?? '', /Save it as preset `conservative` with 1 change \(`sortAttributes`\)\?/);
      const config = JSON.parse(await fs.promises.readFile(path.join(dir, 'html-minifier.config.json'), 'utf8'));
      assert.deepStrictEqual(config, configPreset.config);
    });
  });

  test('Sets the installation apart from the configuration with a blank line', async () => {
    await inDir({ 'node_modules/html-minifier/package.json': PACKAGE_HM }, async (dir) => {
      const logged = /** @type {string[]} */ ([]);
      await offerSetup({ config: CONFIG, cwd: dir, ask: scripted([]).ask, install: fakeInstall().install, log: (message) => logged.push(message) });
      assert.strictEqual(logged[0], '');
    });
  });

  test('Offers to update HTML Minifier where a newer version is out', async () => {
    await inDir({ 'package.json': '{}', 'node_modules/html-minifier/package.json': PACKAGE_HM, 'site/index.html': '' }, async (dir) => {
      const { ask, questions } = scripted(['n', 'y']);
      const { install, calls } = fakeInstall();
      await offerSetup({ config: CONFIG, cwd: path.join(dir, 'site'), ask, install, latest: Promise.resolve('5.2.0'), log() {} });
      assert.match(questions[1] ?? '', /Update HTML Minifier 5\.1\.0 in \.\. to 5\.2\.0 \(latest\)\?/);
      assert.deepStrictEqual(calls, [{ dir, manager: 'npm' }]);
    });
  });

  test('Says when the installed HTML Minifier is the latest', async () => {
    await inDir({ 'node_modules/html-minifier/package.json': PACKAGE_HM }, async (dir) => {
      const logged = /** @type {string[]} */ ([]);
      await offerSetup({ config: CONFIG, cwd: dir, ask: scripted([]).ask, install: fakeInstall().install, latest: Promise.resolve('5.1.0'), log: (message) => logged.push(message) });
      assert.match(logged.join('\n'), /HTML Minifier 5\.1\.0 is installed \(latest\)/);
    });
  });

  test('Names the version to install, where known', async () => {
    await inDir({}, async (dir) => {
      const { ask, questions } = scripted([]);
      await offerSetup({ config: CONFIG, cwd: dir, ask, install: fakeInstall().install, latest: Promise.resolve('5.2.0'), log() {} });
      assert.match(questions[1] ?? '', /Install HTML Minifier 5\.2\.0 \(latest\)\?/);
    });
  });

  test('Works in the project given, naming it where it isn’t the current folder', async () => {
    await inDir({ 'tool/node_modules/html-minifier/package.json': PACKAGE_HM, 'site/package.json': '{}' }, async (dir) => {
      const dirSite = path.join(dir, 'site');
      const { ask, questions } = scripted(['y', '', 'y', '']);
      const { install, calls } = fakeInstall();
      await offerSetup({ config: CONFIG, cwd: path.join(dir, 'tool'), dirProject: dirSite, ask, install, log() {} });
      assert.match(questions[1] ?? '', /Folder \(\.\.[\\/]site\)/);
      assert.ok(fs.existsSync(path.join(dirSite, 'html-minifier.config.json')));
      assert.match(questions[2] ?? '', /Install HTML Minifier/);
      assert.match(questions[3] ?? '', /Folder \(\.\.[\\/]site\)/);
      assert.deepStrictEqual(calls, [{ dir: dirSite, manager: 'npm' }]);
    });
  });

  test('Says where HTML Minifier is installed, where that isn’t the current folder', async () => {
    await inDir({ 'site/node_modules/html-minifier/package.json': PACKAGE_HM, 'site/package.json': '{}' }, async (dir) => {
      const logged = /** @type {string[]} */ ([]);
      await offerSetup({ config: CONFIG, cwd: dir, dirProject: path.join(dir, 'site'), ask: scripted([]).ask, install: fakeInstall().install, log: (message) => logged.push(message) });
      assert.match(logged.join('\n'), /HTML Minifier 5\.1\.0 is installed in site/);
    });
  });

  test('Installs HTML Minifier outside projects only after creating a package.json, if confirmed', async () => {
    await inDir({ '.git/HEAD': '' }, async (dir) => {
      const declined = scripted(['n', 'y', '', 'n']);
      const logged = /** @type {string[]} */ ([]);
      const first = fakeInstall();
      await offerSetup({ config: CONFIG, cwd: dir, ask: declined.ask, install: first.install, log: (message) => logged.push(message) });
      assert.match(declined.questions[3] ?? '', /Create package\.json in current folder\?/);
      assert.deepStrictEqual(first.calls, []);
      assert.ok(!fs.existsSync(path.join(dir, 'package.json')));
      assert.match(logged.join('\n'), /npx html-minifier/);

      const confirmed = scripted(['n', 'y', '', 'y']);
      const second = fakeInstall();
      await offerSetup({ config: CONFIG, cwd: dir, ask: confirmed.ask, install: second.install, log() {} });
      assert.deepStrictEqual(JSON.parse(await fs.promises.readFile(path.join(dir, 'package.json'), 'utf8')), { private: true });
      assert.deepStrictEqual(second.calls, [{ dir, manager: 'npm' }]);
    });
  });
});