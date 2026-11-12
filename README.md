# HTML Minifier Setup (Preview)

[![npm version](https://img.shields.io/npm/v/html-minifier-setup.svg)](https://www.npmjs.com/package/html-minifier-setup) [![Build status](https://github.com/j9t/html-minifier-setup/workflows/Tests/badge.svg)](https://github.com/j9t/html-minifier-setup/actions) [![Socket](https://badge.socket.dev/npm/package/html-minifier-setup)](https://socket.dev/npm/package/html-minifier-setup) [![GitHub Sponsors](https://badgen.net/static/Support/Open%20Source/cyan)](https://github.com/sponsors/j9t)

HTML Minifier Setup (HMS) helps you find the [HTML Minifier](https://github.com/j9t/html-minifier) configuration that saves the most on your pages without changing how they render. It evaluates every option on a sample of your pages, sets aside those that don’t fit—that would change something your pages rely on—, and writes the rest as a configuration file for HTML Minifier.

It also reports what each option saves, which is useful on its own: Which options pay off on your site, and which don’t?

ℹ️ **This is an early release. Options, output, and API may change before 1.0.0. Feedback is welcome.**

## Usage

```shell
npx html-minifier-setup [inputs...] [options]
```

(Like HTML Minifier, HTML Minifier Setup requires Node.js ≥22.13.)

Inputs are HTML files, directories, or URLs (default: the current directory). From directories, up to 20 pages (`--sample`) are picked, spread across subdirectories to cover a site’s templates.

The render check, which catches most of what static checks can’t, uses Playwright’s Chromium, or else Chrome or Edge, if installed. Where none is found, HTML Minifier Setup offers to download Chromium.

On a terminal, HTML Minifier Setup then offers to save the recommended configuration (as html-minifier.config.json, in the project of the pages evaluated or a folder of your choice) and, where it isn’t installed yet, to install HTML Minifier there (with the package manager the project uses), or to update it where a newer version is out. All offers default to no. Where one of HTML Minifier’s presets with a few changes has the same effect, it also offers to save the configuration that way—shorter, and following changes to the preset.

```shell
# Evaluate a build directory and write the configuration to html-minifier.config.json
npx html-minifier-setup ./dist -o

# Use it with HTML Minifier, which picks up html-minifier.config.json from the working directory
npx html-minifier --input-dir ./dist --output-dir ./dist
```

| Option | Description |
| --- | --- |
| `-c, --config-file <file>` | Start from an HTML Minifier configuration (JSON or module; defaults to html-minifier.config.json in the working directory, if present): Options on how input is read (e.g., `ignoreCustomFragments`, `caseSensitive`, `continueOnParseError`) are carried over; values for candidates (e.g., `minifyJS: {"engine": "swc"}`) are evaluated instead of `true`; and `fileExt`, `ignoreDir`, and cache sizes are kept, with `fileExt` and `ignoreDir` also applying to directories read |
| `-o, --output [file]` | Write the configuration to a file (default: html-minifier.config.json) rather than print it |
| `-m, --metric <metric>` | Size that decides whether an option gains: `raw`, `gzip` (default), or `brotli` |
| `-s, --sample <count>` | Pages to evaluate at most (default: 20) |
| `--file-ext <list>` | File extensions to read in directories, `*` for all files (default: `html,htm`, or the configuration’s `fileExt`) |
| `--ignore-dir <list>` | Directory names to skip (default: `node_modules`, or the configuration’s `ignoreDir`) |
| `--keep <list>` | Options to recommend regardless of risks and gains |
| `--skip <list>` | Options not to evaluate |
| `--no-render` | Skip the render check, not recommending options that need it |
| `--no-equivalence` | Skip HTML Minifier’s equivalence check |
| `--no-presets` | Skip comparing with HTML Minifier’s presets |
| `--viewports <list>` | Viewports to render at (default: `1280x800,390x844`) |
| `--concurrency <count>` | Pages to render at once (default: 4) |
| `--json` | Print the full result as JSON |
| `-v, --verbose` | Show every page and viewport in details (rather than a summary with an example), more notes, and progress line by line where STDERR isn’t a terminal |

### Programmatic use

HTML Minifier Setup is ESM-only.

```js
import { createRenderer, customize, loadPages, toConfig } from 'html-minifier-setup';

const pages = await loadPages(['./dist']);
const { renderer } = await createRenderer();
try {
  const result = await customize(pages, { renderer, metric: 'brotli' });
  console.log(toConfig(result));
} finally {
  await renderer?.close();
}
```

## How it works

1. **Each option on its own:** Every candidate option is run on every page and measured against output without it. Options that change nothing (“no effect”), or don’t save anything by the chosen metric (“no gain”), are left out. What an option changes is then checked against what the page relies on (see below).
2. **All recommended options together, rendered:** Pages are rendered as written and as minified, in Chromium (or Chrome or Edge) at each viewport, and compared by screenshot, text, and script errors. Where rendering differs, options are rendered on their own to find the culprit; where none breaks rendering on its own, options are added by savings until rendering holds.
3. **Contributions:** Each option’s share of the final savings is measured by leaving it out. Options that save nothing alongside the others are dropped.
4. **Presets:** HTML Minifier’s presets (`conservative` and `comprehensive`) are measured and rendered on the same pages, naming options they include that don’t fit, to show what the recommended configuration gains over them.

Options that need another (e.g., `removeUnusedCSS` needs `minifyCSS`) are evaluated on top of it. Where the option needed is safe but saves nothing alone, both are evaluated together, and recommended together.

Where full whitespace collapsing breaks a page, HTML Minifier Setup falls back to `conservativeCollapse`, and then to `preserveLineBreaks`.

### Checks

| Check | Catches | Needs |
| --- | --- | --- |
| Static | What scripts and style sheets of the page (including linked local or same-origin ones) rely on: comments that frameworks read (e.g., Knockout, Lit, hydration markers), empty elements scripts fill, classes scripts add after `removeUnusedCSS` removed their rules, attributes that style sheets or scripts select on, and CSS that keeps whitespace | Nothing |
| Render | Anything that changes what the page looks like on load, or adds script errors | Chromium, Chrome, or Edge |
| Equivalence | HTML Minifier bugs, as HTML Minifier’s own check finds output that means something else to browsers than its source—for the options that check models | An HTML Minifier checkout next to this one (for now) |

In the report, options are **recommended**, **kept** (as asked), or not used because they **don’t fit** these pages, have **no gain** by the chosen metric, have **no effect**, or were **skipped**. With `--json`, statuses are `accepted`, `kept`, `rejected`, `no-gain`, `no-effect`, and `skipped`.

Options flagged by the static check as a **risk** don’t fit and aren’t recommended. Options flagged for a **check** (e.g., whitespace collapsing where CSS keeps whitespace) are recommended only if they render the same—without a render check, they’re rejected. **Notes** don’t reject.

Options that make pages look different are mostly doing what they’re designed to do—collapsing whitespace changes spacing where a layout relies on it—so they don’t fit these pages, without HTML Minifier being at fault. Where an option that isn’t meant to change how pages look does, the report suggests it may be an HTML Minifier bug worth reporting. The configuration recommended looks the same as the original pages at every viewport checked.

### Limits

The checks can show that options change pages, not that they never will:

* The render check sees pages as they load, not after interaction (e.g., a menu a script opens, using classes `removeUnusedCSS` removed).
* Scripts from other origins can’t be read, and classes or attributes a script builds at runtime (e.g., `'is-' + state`) can’t be found.
* Rendering must match pixel for pixel, so lossy changes (e.g., SVG coordinates rounded by `minifySVG`) count as differences.
* A page sample may miss templates the rest of the site uses.
* Options that have no effect can’t be judged: On pages that are minified already, most options are left out, as there’s nothing left for them to do. Run HTML Minifier Setup on pages before minification instead.

Test the configuration on your site before deploying it.

Options that newer versions of HTML Minifier add are evaluated once HTML Minifier Setup knows them; until then, the report names them.

Options HTML Minifier can’t express in one configuration are not evaluated: `minifyURLs` depends on each page’s URL, and `removeTagWhitespace` produces invalid HTML.

Large pages take longer, especially by `brotli`, which is measured at the highest quality.