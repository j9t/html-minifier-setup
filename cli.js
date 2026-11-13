#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { Command, Option } from 'commander';
import { splitConfig } from './src/catalog.js';
import { paint, supportsColor } from './src/color.js';
import { loadEquivalence } from './src/equivalence.js';
import { METRICS } from './src/measure.js';
import { EXTENSIONS_DEFAULT, findOutsideLinks, loadPages } from './src/pages.js';
import { createProgress } from './src/progress.js';
import { CONCURRENCY_DEFAULT, createRenderer, installChromium, VIEWPORTS_DEFAULT } from './src/render.js';
import { formatReport, toConfig, toPresetConfig } from './src/report.js';
import { customize } from './src/select.js';
import { CONFIG_FILE as CONFIG_FILE_DEFAULT, fetchLatestVersion, isYes, offerSetup, projectOf } from './src/setup.js';

let progress = createProgress();

const { version } = JSON.parse(fs.readFileSync(new URL('package.json', import.meta.url), 'utf8'));

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value.map(String) : String(value).split(',')).map((item) => item.trim()).filter(Boolean);

/** @param {string} value */
const positiveInteger = (value) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Not a positive integer: ${value}`);
  return number;
};

/** @param {string} value */
const viewports = (value) => {
  const items = list(value);
  if (!items.length) throw new Error('No viewports given (e.g., 1280x800,390x844)');
  return items.map((item) => {
    const match = item.match(/^([1-9]\d*)x([1-9]\d*)$/);
    if (!match) throw new Error(`Not a viewport (e.g., 1280x800): ${item}`);
    return { width: Number(match[1]), height: Number(match[2]) };
  });
};

/**
 * @param {string} file
 * @returns {Promise<Record<string, unknown>>}
 */
async function readConfig(file) {
  const resolved = path.resolve(file);
  if (/\.[cm]?js$/.test(resolved)) {
    const module = await import(pathToFileURL(resolved).href);
    return module.default ?? module;
  }
  return JSON.parse(await fs.promises.readFile(resolved, 'utf8'));
}

const program = new Command()
  .name('html-minifier-setup')
  .description('Identifies the HTML Minifier options that save the most on your pages without changing how they render')
  .version(version)
  .argument('[inputs...]', 'HTML files, directories, or URLs', ['.'])
  .option('-c, --config-file <file>', `Start from an HTML Minifier configuration (JSON or module), carrying over its input handling options (defaults to ${CONFIG_FILE_DEFAULT} in the working directory, if present)`)
  .option('-o, --output [file]', `Write the configuration to a file (default: ${CONFIG_FILE_DEFAULT}) rather than print it`)
  .addOption(new Option('-m, --metric <metric>', 'Size that decides whether an option gains').choices(METRICS).default('gzip'))
  .option('-s, --sample <count>', 'Pages to evaluate at most, spread across directories', positiveInteger, 20)
  .option('--file-ext <list>', 'File extensions to read in directories (`*` for all files)', list, EXTENSIONS_DEFAULT)
  .option('--ignore-dir <list>', 'Directory names to skip', list, ['node_modules'])
  .option('--keep <list>', 'Options to recommend regardless of risks and gains', list, [])
  .option('--skip <list>', 'Options not to evaluate', list, [])
  .option('--no-render', 'Skip the render check (not recommending options that need it)')
  .option('--no-equivalence', 'Skip HTML Minifier’s equivalence check')
  .option('--no-presets', 'Skip comparing with HTML Minifier’s presets')
  .option('--viewports <list>', 'Viewports to render at', viewports, VIEWPORTS_DEFAULT)
  .option('--concurrency <count>', 'Pages to render at once', positiveInteger, CONCURRENCY_DEFAULT)
  .option('--follow-links', 'Follow symbolic links outside the site in the render check, without asking (do so only for sites you trust)')
  .option('--json', 'Print the full result as JSON')
  .option('-v, --verbose', 'Show every page and viewport in details, progress line by line where STDERR isn’t a terminal, and more notes')
  .action(async (inputs, settings, command) => {
    if (settings.verbose) progress = createProgress({ verbose: true });
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !settings.output && !settings.json;
    // Asked while pages are evaluated, for the offers at the end
    const latest = interactive && !process.env.CI && !process.env.NO_UPDATE_NOTIFIER ? fetchLatestVersion('html-minifier') : null;

    // As HTML Minifier does, a configuration in the working directory is used where none is given
    let fileConfig = settings.configFile;
    if (!fileConfig && fs.existsSync(path.resolve(CONFIG_FILE_DEFAULT))) {
      fileConfig = CONFIG_FILE_DEFAULT;
      progress.log(`Using config file ${CONFIG_FILE_DEFAULT}`);
    }
    const { base, values, preserved, ignored } = splitConfig(fileConfig ? await readConfig(fileConfig) : {});
    if (ignored.length && settings.verbose) progress.log(`Not carried from ${fileConfig}: ${ignored.join(', ')}`);
    /** @param {'fileExt' | 'ignoreDir'} name */
    const fromConfig = (name) => command.getOptionValueSource(name) === 'default' && preserved[name] !== undefined ? list(preserved[name]) : settings[name];

    progress.update({ phase: 'read', detail: inputs.join(', ') });
    const pages = await loadPages(inputs, { extensions: fromConfig('fileExt'), ignore: fromConfig('ignoreDir'), sample: settings.sample });
    if (!pages.length) throw new Error(`No pages found in ${inputs.join(', ')}`);

    const followLinks = settings.render && (settings.followLinks || (interactive && await confirmLinks(pages, fromConfig('ignoreDir'))));
    const settingsRenderer = { viewports: settings.viewports, concurrency: settings.concurrency, followLinks };
    if (settings.render) progress.update({ phase: 'start' });
    let rendering = settings.render ? await createRenderer(settingsRenderer) : { renderer: null, reason: 'skipped as asked' };
    if ('missing' in rendering && rendering.missing && interactive) {
      progress.stop({ ok: false });
      const download = await withPrompt(async (ask) => isYes(await ask('No browser found for the render check. Download Chromium (about 150 MB)? (y/N) ')));
      if (download && await installChromium()) {
        progress.update({ phase: 'start' });
        rendering = await createRenderer(settingsRenderer);
      }
    }
    const { renderer, reason } = rendering;
    const equivalence = settings.equivalence ? await loadEquivalence() : null;
    try {
      const result = await customize(pages, {
        base,
        values,
        metric: settings.metric,
        keep: settings.keep,
        skip: settings.skip,
        renderer,
        equivalence,
        presets: settings.presets,
        onProgress: progress.update
      });
      // Sets the finished phases apart from the report
      if (progress.stop() && process.stdout.isTTY) console.log('');
      if (settings.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const color = supportsColor(process.stdout);
      console.log(formatReport(result, { renderReason: reason, color, verbose: settings.verbose }));
      const config = toConfig(result, preserved);
      if (settings.output) {
        const fileOutput = settings.output === true ? CONFIG_FILE_DEFAULT : settings.output;
        await fs.promises.writeFile(fileOutput, `${JSON.stringify(config, null, 2)}\n`);
        console.log(`\nWrote ${fileOutput}`);
        return;
      }
      console.log(`\n${paint('bold', 'Recommended configuration:', color)}\n${JSON.stringify(config, null, 2)}\n`);
      if (interactive) await promptSetup(config, toPresetConfig(result, preserved), latest, projectOf(inputs, process.cwd()));
    } finally {
      await renderer?.close();
    }
  });

/**
 * Whether to follow symbolic links outside the site, as a page’s scripts could send on what they
 * lead to: asked where any are found (the report names files not gotten either way)
 * @param {import('./src/pages.js').Page[]} pages
 * @param {string[]} ignore
 */
async function confirmLinks(pages, ignore) {
  const roots = [...new Set(pages.flatMap(({ root }) => root ? [root] : []))];
  const links = (await Promise.all(roots.map((root) => findOutsideLinks(root, ignore)))).flat()
    .map(({ link, target }) => ({ link: path.relative(process.cwd(), link), target }));
  if (!links.length) return false;
  progress.stop();
  const named = `${links.slice(0, 3).map(({ link, target }) => `${link} → ${target}`).join(', ')}${links.length > 3 ? `, and ${links.length - 3} more` : ''}`;
  return withPrompt(async (ask) => isYes(await ask(`The site links to files outside it (${named}). Follow these links in the render check? Only do so for sites you trust, as their scripts could send on what the links lead to (y/N) `)));
}

/**
 * Asks on the terminal whether to save the configuration and install HTML Minifier
 * @param {Record<string, unknown>} config
 * @param {ReturnType<typeof toPresetConfig>} configPreset
 * @param {Promise<string | null> | null} latest
 * @param {string} dirProject
 */
async function promptSetup(config, configPreset, latest, dirProject) {
  await withPrompt((ask) => offerSetup({ config, configPreset, latest, dirProject, cwd: process.cwd(), ask, log: (message) => console.log(message) }));
}

/**
 * Runs `fn` with a way to ask questions on the terminal
 * @template T
 * @param {(ask: (question: string) => Promise<string>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPrompt(fn) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    rl.close();
    process.exit(130);
  });
  try {
    return await fn((question) => rl.question(question));
  } finally {
    rl.close();
  }
}

try {
  await program.parseAsync();
} catch (err) {
  progress.stop({ ok: false });
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}