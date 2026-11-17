# Changelog

All notable changes to HTML Minifier Setup (HMS) are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-11-17

### Fixed

* Stopped attributing options for what HTML Minifier does anyway: Options are now render-checked against pages as HTML Minifier puts them out without options (e.g., without `htmlmin:ignore` comments), not as written, which had made every option look different where that alone did
* Stopped taking anti-aliasing for a difference: Screenshots are compared beyond anti-aliasing, as text that moves by less than a pixel rasterizes differently, and moves of less than a pixel are ignored, while what looks different without moving (e.g., colors) still counts
* Stopped taking whitespace that only shows in text for a difference (e.g., between flex items), while words running together or apart still count where pages look different
* Stopped showing the configuration matching the pages where options that save something were rejected, where it read like an alternative to them
* Got the same files from other origins (e.g., CDNs) in every load, fetching them once per run, rather than loading them anew each time
* Loaded lazy images before taking screenshots, which, by when lazy images had loaded, could look different between loads

### Added

* Told how far elements move where that is all an option (or preset) changes (e.g., “Moves elements by up to 10 px at 1280×800 (e.g., header > nav > ul > li)”), rather than only that pages look different
* Added `--allow-shift <px>` to accept moves up to the given pixels where nothing else changes, not even spaces between words; the report suggests it where options only move elements
* Named style sheets, scripts, and fonts that didn’t load in the render check (`failed` with `--json`), no longer calling the configuration the same as the original pages
* Listed options with the same details once, together, rather than repeating the details for each

## [0.5.0] - 2026-11-16

### Fixed

* Stopped recommending a configuration without options (only `$schema`): The report now says why no option fits, `-o` writes no file, and no configuration is offered to save
* Stopped script errors that come and go between loads (e.g., of YouTube embeds) from rejecting options at random: New script errors now need to show on a second load of the minified page, and errors of either load of the original are known
* Evaluated options together with what they need where that is in effect already, as where it has no effect

### Added

* Told options in effect already from options with nothing to act on: Where an option changes nothing but the pages have what it acts on, all in the form it produces (e.g., unquoted attribute values for `removeAttributeQuotes`), it’s reported as already in effect (`in-effect` with `--json`)
* Showed the configuration matching pages that are minified already, by the options in effect already, where no option is recommended—useful when switching from another minifier, and offered to save it

### Changed

* **BREAKING:** Options that changed nothing were all `no-effect` with `--json`; those whose work the pages show done are now `in-effect`

## [0.4.0] - 2026-11-15

### Fixed

* Stopped options kept with `--keep` that make pages look different from getting all other options rejected: Pages that look different with the kept options alone are no longer used to render-check the others, and the report notes them
* Kept the browser from taking 30 seconds to close in Chrome after a page stopped responding
* Kept the render check from hanging where the browser stops responding (as Chrome and Edge can on macOS): Pages are then noted as not render-checked, without waiting again, and the browser is ended

### Changed

* **BREAKING:** Removed the programmatic API, as HMS is best run once rather than kept as a dependency; use `--json` or `-o` in scripts and CI

## [0.3.0] - 2026-11-14

### Fixed

* Kept crafted style sheets (e.g., selectors with many unclosed `:x(` or deeply nested rules) from stalling the static checks
* Matched whitespace rules by the selector outside nested parentheses, by escaped class names and IDs (e.g., Tailwind’s `.md\:whitespace-pre-line`), and by attribute selectors whatever their values hold (e.g., `a[href$=".txt"]`), which had kept options that collapse whitespace from being flagged
* Flagged whitespace that CSS keeps with values not led by the keyword that keeps it (e.g., `white-space: nowrap preserve`)
* Flagged `removeUnusedCSS` where it removes rules for escaped classes that scripts name, also in selectors (e.g., `.md\:open`)
* Kept no-break spaces in class names from separating classes, which only ASCII whitespace does
* Stopped flagging changed inline styles (e.g., by `collapseAttributeWhitespace`) as attributes that style sheets select on

### Changed

* Switched to reading style sheets with [Lightning CSS](https://lightningcss.dev/), which HTML Minifier uses already, rather than with regular expressions: The static checks now follow nested rules (e.g., `&:hover`) and scopes (`@scope`), and take style sheets as browsers do, dropping invalid rules and imports that follow other rules

## [0.2.0] - 2026-11-13

### Fixed

* Read starting configurations as HTML Minifier does: with a byte order mark, and, without a `.json` extension, as JSON or else as module
* Carried input handling options (e.g., `caseSensitive`) of a preset a starting configuration names
* Spread page samples across a site’s sections and then across the folders within them, rather than taking the first folders where each page has its own (e.g., blog/10/, blog/11/, …)
* Named options presets include in a form that doesn’t fit (e.g., full whitespace collapsing where only `preserveLineBreaks` fits)

### Added

* Added an introduction where the CLI starts on a terminal
* Added how many pages a sample was taken from to the report (e.g., “Evaluated 20 of 1,234 pages (use `--sample` to evaluate more)”) and, as `pagesFound`, to the result

### Changed

* Minified pages on worker threads, in parallel, and measured what options contribute in fewer rounds, which cuts the time without the render check by about a third on sample pages
* Checked options to keep or skip before reading pages and starting the browser
* Made HTML Minifier’s equivalence check development-only, as it only ran next to an HTML Minifier checkout: The report no longer says “Not equivalence-checked,” `--no-equivalence` is no longer listed, and `loadEquivalence` is no longer exported

## [0.1.0] - 2026-11-13

### Added

* Released first version