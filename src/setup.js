// Offers to save the configuration and to install or update HTML Minifier, each declined by
// default

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'html-minifier.config.json';

/** @typedef {'npm' | 'pnpm' | 'yarn' | 'bun'} PackageManager */

/** @type {[string, PackageManager][]} */
const LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']];

/** @type {Record<PackageManager, string[]>} */
export const INSTALL_ARGS = {
  npm: ['install', '--save-dev'],
  pnpm: ['add', '--save-dev'],
  yarn: ['add', '--dev'],
  bun: ['add', '--dev']
};

/**
 * The directory and its ancestors, nearest first
 * @param {string} dir
 */
function* upwards(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    yield current;
    if (path.dirname(current) === current) return;
  }
}

/**
 * Finds a package where Node would resolve it from the directory
 * @param {string} name
 * @param {string} dir
 * @returns {{dir: string, version: string} | null}
 */
export function findPackage(name, dir) {
  for (const current of upwards(dir)) {
    const filePackage = path.join(current, 'node_modules', name, 'package.json');
    if (fs.existsSync(filePackage)) {
      return { dir: path.dirname(filePackage), version: JSON.parse(fs.readFileSync(filePackage, 'utf8')).version };
    }
  }
  return null;
}

/**
 * The nearest directory with a package.json within the repository, the repository, or else the
 * directory itself
 * @param {string} dir
 */
function findRoot(dir) {
  for (const current of upwards(dir)) {
    if (fs.existsSync(path.join(current, 'package.json')) || fs.existsSync(path.join(current, '.git'))) return current;
  }
  return dir;
}

/**
 * The project the inputs belong to: that of the first local input, or else the working directory
 * @param {string[]} inputs
 * @param {string} cwd
 */
export function projectOf(inputs, cwd) {
  const input = inputs.find((item) => !/^https?:\/\//i.test(item));
  if (input === undefined) return cwd;
  const resolved = path.resolve(cwd, input);
  const dir = fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory() ? path.dirname(resolved) : resolved;
  return findRoot(dir);
}

/**
 * The package manager a package.json declares, if known
 * @param {string} dir
 * @returns {PackageManager | null}
 */
function declaredPackageManager(dir) {
  try {
    const name = String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager ?? '').split('@')[0];
    return name && name in INSTALL_ARGS ? /** @type {PackageManager} */ (name) : null;
  } catch {
    return null;
  }
}

/**
 * The package manager of the nearest project, by lockfile, then by declaration
 * @param {string} dir
 * @returns {PackageManager}
 */
export function detectPackageManager(dir) {
  for (const current of upwards(dir)) {
    const found = LOCKFILES.find(([file]) => fs.existsSync(path.join(current, file)));
    if (found) return found[1];
    const declared = declaredPackageManager(current);
    if (declared) return declared;
  }
  return 'npm';
}

/**
 * Installs HTML Minifier as development dependency, showing the package manager’s output
 * @param {string} dir
 * @param {PackageManager} manager
 * @returns {Promise<boolean>}
 */
export const installPackage = (dir, manager) => new Promise((resolve) => {
  const child = spawn(manager, [...INSTALL_ARGS[manager], 'html-minifier@latest'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('error', () => resolve(false));
  child.on('close', (code) => resolve(code === 0));
});

/**
 * The latest version of a package, or null where the registry can’t tell in time
 * @param {string} name
 * @param {{fetch?: (url: string, init?: RequestInit) => Promise<Response>, registry?: string, timeout?: number}} [settings]
 * @returns {Promise<string | null>}
 */
export async function fetchLatestVersion(name, { fetch = globalThis.fetch, registry = process.env.npm_config_registry || 'https://registry.npmjs.org/', timeout = 3000 } = {}) {
  try {
    const response = await fetch(`${registry.replace(/\/?$/, '/')}${name}/latest`, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return null;
    const { version } = await response.json();
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** @param {string} version */
const parseVersion = (version) => {
  const [, core = '', prerelease = ''] = /^v?([^+-]*)(?:-([^+]*))?/.exec(version.trim()) ?? [];
  return { core: core.split('.').slice(0, 3).map(Number), prerelease: prerelease ? prerelease.split('.') : [] };
};

/**
 * Whether version `a` is newer than `b`, by SemVer precedence
 * @param {string} a
 * @param {string} b
 */
export function isNewer(a, b) {
  const [versionA, versionB] = [parseVersion(a), parseVersion(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (versionA.core[index] ?? 0) - (versionB.core[index] ?? 0);
    if (difference) return difference > 0;
  }
  // A release is newer than its prereleases
  if (!versionA.prerelease.length || !versionB.prerelease.length) return !versionA.prerelease.length && versionB.prerelease.length > 0;
  for (let index = 0; ; index++) {
    const [idA, idB] = [versionA.prerelease[index], versionB.prerelease[index]];
    if (idA === undefined || idB === undefined) return idB === undefined && idA !== undefined;
    if (idA === idB) continue;
    const [numericA, numericB] = [/^\d+$/.test(idA), /^\d+$/.test(idB)];
    // Numeric identifiers rank below alphanumeric ones
    if (numericA && numericB) return Number(idA) > Number(idB);
    return numericA === numericB ? idA > idB : numericB;
  }
}

/** @param {string} answer */
export const isYes = (answer) => /^\s*y(?:es)?\s*$/i.test(answer);

/**
 * @param {string} dir
 * @param {string} cwd
 */
const describeDir = (dir, cwd) => dir === cwd ? 'current folder' : path.relative(cwd, dir) || '.';

/**
 * @param {{config: Record<string, unknown>, dirProject?: string, configPreset?: {name: string, changes: string[], config: Record<string, unknown>} | null, cwd: string, ask: (question: string) => Promise<string>, install?: (dir: string, manager: PackageManager) => Promise<boolean>, latest?: Promise<string | null> | null, log: (message: string) => void}} settings
 * @returns {Promise<{fileConfig: string | null, installed: boolean}>}
 */
export async function offerSetup({ config, dirProject, configPreset = null, cwd, ask, install = installPackage, latest = null, log }) {
  /** @type {string | null} */
  let fileConfig = null;
  let dirTarget = dirProject ?? cwd;

  if (isYes(await ask('Save configuration file? (y/N) '))) {
    dirTarget = path.resolve(cwd, (await ask(`Folder (${describeDir(dirTarget, cwd)}): `)).trim() || dirTarget);
    const file = path.join(dirTarget, CONFIG_FILE);
    if (!fs.existsSync(file) || isYes(await ask(`Overwrite ${path.relative(cwd, file)}? (y/N) `))) {
      const asPreset = configPreset && isYes(await ask(`Save it as preset “${configPreset.name}” with ${configPreset.changes.length} change${configPreset.changes.length === 1 ? '' : 's'} (${configPreset.changes.join(', ')})? Same effect, shorter, and follows changes to the preset (y/N) `));
      await fs.promises.mkdir(dirTarget, { recursive: true });
      await fs.promises.writeFile(file, `${JSON.stringify(asPreset ? configPreset.config : config, null, 2)}\n`);
      fileConfig = file;
      log(`Saved ${path.relative(cwd, file)}${dirTarget === cwd ? '' : '—HTML Minifier reads it when run from that folder'}`);
    } else {
      log('Not saved');
    }
  }

  log('');
  const found = findPackage('html-minifier', dirTarget);
  const versionLatest = await latest;
  if (found) {
    // As the project folder above `node_modules`
    const dirInstalled = path.dirname(path.dirname(found.dir));
    const where = dirInstalled === cwd ? '' : ` in ${describeDir(dirInstalled, cwd)}`;
    if (!versionLatest || !isNewer(versionLatest, found.version)) {
      log(`HTML Minifier ${found.version} is installed${where}${versionLatest ? ' (latest)' : ''}`);
    } else if (isYes(await ask(`Update HTML Minifier ${found.version}${where} to ${versionLatest} (latest)? (y/N) `))) {
      if (!await install(dirInstalled, detectPackageManager(dirInstalled))) log('Update failed');
    }
    return { fileConfig, installed: true };
  }
  let installed = false;
  if (isYes(await ask(`Install HTML Minifier${versionLatest ? ` ${versionLatest} (latest)` : ''}? (y/N) `))) {
    const dirDefault = findRoot(dirTarget);
    const dirInstall = path.resolve(cwd, (await ask(`Folder (${describeDir(dirDefault, cwd)}): `)).trim() || dirDefault);
    const filePackage = path.join(dirInstall, 'package.json');
    // Package managers would otherwise install into the nearest project above
    if (!fs.existsSync(filePackage)) {
      if (!isYes(await ask(`Create package.json in ${describeDir(dirInstall, cwd)}? Needed to install there (y/N) `))) {
        log('Not installed—`npx html-minifier` runs HTML Minifier without installing it');
        return { fileConfig, installed };
      }
      await fs.promises.mkdir(dirInstall, { recursive: true });
      await fs.promises.writeFile(filePackage, `${JSON.stringify({ private: true }, null, 2)}\n`);
    }
    installed = await install(dirInstall, detectPackageManager(dirInstall));
    if (!installed) log('Installation failed');
  }
  return { fileConfig, installed };
}