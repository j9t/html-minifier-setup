# Changelog

All notable changes to HTML Minifier Setup (HMS) are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-13

### Fixed

* Kept crafted style sheets (e.g., selectors with many unclosed `:x(` or deeply nested rules) from stalling the static checks
* Matched whitespace rules by the selector outside nested parentheses, by escaped class names and IDs (e.g., Tailwind’s `.md\:whitespace-pre-line`), and by attribute selectors whatever their values hold (e.g., `a[href$=".txt"]`), which had kept options that collapse whitespace from being flagged
* Flagged whitespace that CSS keeps with values not led by the keyword that keeps it (e.g., `white-space: nowrap preserve`)
* Flagged style rules that `removeUnusedCSS` removes for escaped classes that scripts name (e.g., `.md\:open`)
* Stopped flagging changed inline styles (e.g., by `collapseAttributeWhitespace`) as attributes that style sheets select on

### Changed

* Read style sheets with Lightning CSS, which HTML Minifier uses already, rather than with regular expressions: The static checks now follow nested rules (e.g., `&:hover`), and take style sheets as browsers do, dropping invalid rules and imports that follow other rules

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