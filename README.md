# HTML Minifier Setup (Beta)

[![npm version](https://img.shields.io/npm/v/html-minifier-setup.svg)](https://www.npmjs.com/package/html-minifier-setup) [![Build status](https://github.com/j9t/html-minifier-setup/workflows/Tests/badge.svg)](https://github.com/j9t/html-minifier-setup/actions) [![Socket](https://badge.socket.dev/npm/package/html-minifier-setup)](https://socket.dev/npm/package/html-minifier-setup) [![GitHub Sponsors](https://badgen.net/static/Support/Open%20Source/cyan)](https://github.com/sponsors/j9t)

HTML Minifier Setup (HMS) helps you select the [HTML Minifier](https://www.npmjs.com/package/html-minifier) configuration that saves the most on your pages without changing how they render. It evaluates every option on a sample of your pages, sets aside those that don’t fit—i.e., that would change something your pages rely on—as well as those that save nothing, and provides a custom configuration for HTML Minifier.

It also reports what each option saves, which is useful on its own: Which options pay off on your site, and which don’t?

⚠️ **This is an early release that may not work accurately yet. Options and output may change. You’re encouraged to re-test your configuration come version 1+. [Issue reports and feedback](https://github.com/j9t/html-minifier-setup/issues) are welcome.**

## Usage

```shell
npx html-minifier-setup [inputs...] [options]
```

(Like HTML Minifier, HTML Minifier Setup requires Node.js ≥22.13.)

Inputs are HTML files, directories, or URLs (default: the current directory). From directories, up to 20 pages (`--sample`) are picked, spread across a site’s sections first and then across the directories within them, to try to cover its templates. The same pages give the same sample, and the report says how many pages it was taken from.

The render check uses Playwright’s Chromium, or else Chrome or Edge, if installed. Where none is found, HTML Minifier Setup offers to download Chromium.

Local pages are served to the browser from their directory. Symbolic links that lead outside it are followed only if you agree (or pass `--follow-links`), as a page’s scripts could send on what they lead to. Where nobody can answer, they aren’t followed.

Where no option fits, HTML Minifier Setup says why. On pages that are already minified, where no option that saves something was rejected, it then shows the configuration matching them, by the options in effect already (see below)—useful when switching from another minifier.

On a terminal, HTML Minifier Setup offers to save the recommended configuration (or else the one matching the pages; as html-minifier.config.json, in the project of the pages evaluated or a directory of your choice) and, where it isn’t installed yet, to install HTML Minifier there (with the package manager the project uses), or to update it where a newer version is out. All offers default to no. Where one of HTML Minifier’s presets with a few changes has the same effect, it also offers to save the configuration that way—shorter, and following changes to the preset.

```shell
# Evaluate a build directory and write the configuration to html-minifier.config.json
npx html-minifier-setup ./dist -o

# Use it with HTML Minifier, which picks up html-minifier.config.json from the working directory
npx html-minifier --input-dir ./dist --output-dir ./dist
```

| Option | Description |
| --- | --- |
| `-c, --config-file <file>` | Start from an HTML Minifier configuration (JSON or module; defaults to html-minifier.config.json in the working directory, if present): Options on how input is read (e.g., `ignoreCustomFragments`, `caseSensitive`, `continueOnParseError`) are carried over; values for candidates (e.g., `minifyJS: {"engine": "swc"}`) are evaluated instead of `true`; and `fileExt`, `ignoreDir`, and cache sizes are kept, with `fileExt` and `ignoreDir` also applying to directories read |
| `-o, --output [file]` | Write the configuration to a file (default: html-minifier.config.json) rather than print it, writing none where no option fits |
| `-m, --metric <metric>` | Size that decides whether an option gains: `raw`, `gzip` (default), or `brotli`, compressed at Gzip level 6 and Brotli quality 6, common defaults for on-the-fly compression (as in HTML Minifier’s benchmarks) |
| `-s, --sample <count>` | Pages to evaluate at most (default: 20) |
| `--file-ext <list>` | File extensions to read in directories, `*` for all files (default: `html,htm,shtml,shtm`, as HTML Minifier, or the configuration’s `fileExt`) |
| `--ignore-dir <list>` | Directory names to skip (default: `node_modules`, or the configuration’s `ignoreDir`) |
| `--keep <list>` | Options to recommend regardless of risks and gains (pages they make look different aren’t used to render-check other options) |
| `--skip <list>` | Options not to evaluate |
| `--no-render` | Skip the render check, not recommending options that need it |
| `--no-presets` | Skip comparing with HTML Minifier’s presets |
| `--viewports <list>` | Viewports to render at (default: `1280x800,390x844`) |
| `--allow-shift <px>` | Pixels elements may move or change size by in the render check, where nothing else changes, not even spaces between words (default: `0`); the report names how far options move elements, and suggests this where that is all they change |
| `--concurrency <count>` | Pages to render at once, across viewports and options (default: 4) |
| `--follow-links` | Follow symbolic links outside the site in the render check, without asking (do so only for sites you trust) |
| `--json` | Print the full result as JSON |
| `-v, --verbose` | Show every page and viewport in details (rather than a summary with an example), more notes, and progress line by line where STDERR isn’t a terminal |

### Scripts and CI

HTML Minifier Setup is meant to be run, which is why it has no programmatic API. For scripts and CI, use `--json` (which prints the full result) or `-o` (which writes the configuration).

## How It Works

1. **Each option on its own:** Every candidate option is run on every page and measured against output without it. Options that change nothing (“no effect,” or “in effect already” where the page has what they act on in the form they produce), or don’t save anything by the chosen metric (“no gain”), are left out. What an option changes is then checked against what the page relies on (see below).
2. **All recommended options together, rendered:** Pages are rendered as HTML Minifier puts them out without options (twice, to tell what differs between loads) and as minified, in Chromium (or Chrome or Edge) at each viewport, and compared by screenshot, text, and script errors. That way, options aren’t attributed for what HTML Minifier does anyway (e.g., removing `htmlmin:ignore` comments); where that alone looks different from the pages as written, the report notes it. Screenshots are compared beyond anti-aliasing, as text that moves by less than a pixel rasterizes differently, and text regardless of whitespace that doesn’t show (e.g., between flex items), while words running together or apart count. New script errors are confirmed by loading the minified page again, as some (e.g., of embeds) come and go. Files from other origins (e.g., CDNs) are fetched once for all loads, and the report names those that didn’t load. Where rendering differs, options are rendered on their own to find the culprit; where none breaks rendering on its own, options are added by savings until rendering holds.
3. **Contributions:** Each option’s share of the final savings is measured by leaving it out. Options that save nothing alongside the others are dropped.
4. **Presets:** HTML Minifier’s presets (`conservative` and `comprehensive`) are measured and rendered on the same pages, naming options they include that don’t fit, to show what the recommended configuration gains over them.

Options that need another (e.g., `removeUnusedCSS` needs `minifyCSS`) are evaluated on top of it. Where the option needed is safe but saves nothing alone, both are evaluated together, and recommended together.

Where full whitespace collapsing breaks a page, HTML Minifier Setup falls back to `conservativeCollapse`, and then to `preserveLineBreaks`.

### Checks

| Check | Catches | Needs |
| --- | --- | --- |
| Static | What scripts and style sheets of the page (including linked local or same-origin ones) rely on: comments that frameworks read (e.g., Knockout, Lit, hydration markers), empty elements scripts fill, classes scripts add after `removeUnusedCSS` removed their rules, attributes that style sheets or scripts select on, and CSS that keeps whitespace | Nothing |
| Render | Anything that changes what the page looks like on load, or adds script errors | Chromium, Chrome, or Edge |

In the report, options are _recommended_, _kept_ (as asked), or not used because they _don’t fit_ these pages, are _in effect already_, have _no gain_ by the chosen metric, have _no effect_, or were _skipped_. With `--json`, statuses are `accepted`, `kept`, `rejected`, `in-effect`, `no-gain`, `no-effect`, and `skipped`.

Options _in effect already_ change nothing, but the pages have what they act on, all in the form they produce (e.g., attribute values without quotes, for `removeAttributeQuotes`). As they change nothing, the checks can’t vouch for them; they make up the configuration matching the pages, which is to be checked on pages before minification. Options that remove things (e.g., `removeComments`) leave no such traces, as what’s missing may never have been there.

Options flagged by the static check as a _risk_ don’t fit and aren’t recommended. Options flagged for a _check_ (e.g., whitespace collapsing where CSS keeps whitespace) are recommended unless they render differently—without a render check, they’re rejected. Where the render check can’t tell (e.g., on pages that look different between loads or with options kept), the report says so. _Notes_ don’t reject.

Options that make pages look different are mostly doing what they’re designed to do—collapsing whitespace changes spacing where a layout relies on it—so they don’t fit these pages, without HTML Minifier being at fault. Where an option that isn’t meant to change how pages look does, the report suggests it may be an HTML Minifier bug worth reporting. Where an option only moves elements, the report says by how much, and `--allow-shift` accepts moves that small. The configuration recommended looks the same as the original pages at every viewport checked (but for moves `--allow-shift` accepts).

### Limits

The checks can show that options change pages, not that they never will:

* The render check sees pages as they load, not after interaction (e.g., a menu a script opens, using classes `removeUnusedCSS` removed).
* Scripts from other origins can’t be read, and classes or attributes a script builds at runtime (e.g., `'is-' + state`) can’t be found.
* Screenshots must match exactly, except for anti-aliasing and moves of less than a pixel. Lossy changes (e.g., SVG coordinates that `minifySVG` rounds) therefore count as differences. The tolerance isn’t perfect: Some anti-aliasing may still count, and subtle color changes on thin text may go unnoticed.
* Pages that options kept with `--keep` make look different can’t show whether other options do, too.
* A page sample may miss templates the rest of the site uses—for sites with many different templates, raise `--sample`.
* Options that change nothing can’t be judged: On pages that are minified already, most options are left out, as there’s nothing left for them to do, and the configuration matching them is inferred, not checked. Run HTML Minifier Setup on pages before minification instead.

Test the configuration on your site before deploying it.

Options that newer versions of HTML Minifier add are evaluated once HTML Minifier Setup knows them; until then, the report names them.

Options HTML Minifier can’t express in one configuration are not evaluated: `minifyURLs` depends on each page’s URL, and `removeTagWhitespace` produces invalid HTML.

Large pages take longer, especially by `brotli`.

## Working on HTML Minifier Setup

Note: This section assumes working with dependencies installed (`npm i`).

### Tests

```shell
npm test
```

Runs the type check (`tsc`) and then the suites in test/. Render tests skip where no browser is installed (`npx playwright install chromium` installs one). `npm run lint` covers the rest.

### Equivalence Check

With an [HTML Minifier](https://github.com/j9t/html-minifier) checkout next to this one (../html-minifier), runs also use HTML Minifier’s equivalence check (test/equivalence/ there), which finds output that means something else to browsers than its source—HTML Minifier bugs rather than what a site relies on. Options whose output it flags don’t fit, and the report names the check and the HTML Minifier versions involved. It covers the options the check models.

The check runs on the main thread and adds noticeably to the time evaluating options takes; `--no-equivalence` skips it. Without a checkout, as for users, it doesn’t run, and test/equivalence.test.js skips.

### Benchmarks

```shell
npm run benchmark
```

Times a run by phase as the CLI does it—including the equivalence check, where available, and the presets—on the test fixtures, or on files, directories, or URLs passed as arguments. Times are each phase’s fastest iteration.

Parameters:

* No argument: Runs and, if a baseline exists, shows deltas
* `--save`: Saves the run as the baseline (benchmark/benchmark-baseline.json, e.g., on `main` before switching to a branch)
* `--no-render`: Skips the render check, timing what doesn’t need a browser
* `--iterations=N`: Sets the number of timed iterations (default: 3)

Runs are only compared with a baseline taken with the same inputs, render setting, and iterations. To profile, run `node --cpu-prof benchmark/benchmark.js` and load the .cpuprofile file in Chrome DevTools or with `npx speedscope`.

***

You might like some of my other work:

* Optimization tools: [hihtml](https://github.com/j9t/hihtml) · [HTML Minifier](https://github.com/j9t/html-minifier) · [CSS Dedup](https://github.com/j9t/css-dedup) · [Image Guard](https://github.com/j9t/image-guard) · [more](https://github.com/j9t?tab=repositories)
* Defense tools: [AWAGAM TLD, Domain, and URL Blocker](https://iadefensa.com/solutions/awagam-chromium/) · [Middleman Alerter](https://iadefensa.com/solutions/middleman-alerter-chromium/) · [New Tab Traffic Randomizer](https://iadefensa.com/solutions/new-tab-traffic-randomizer-chromium/) · [Searcher](https://iadefensa.com/solutions/searcher-chromium/) · [more](https://iadefensa.com/solutions/)
* Resources for quality web development: [Articles](https://meiert.com/topics/development/) · [Books](https://meiert.com/topics/books/) · [News](https://dxsrc.org/) · [Terminology](https://webglossary.info/)