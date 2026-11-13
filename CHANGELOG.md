# Changelog

All notable changes to HTML Minifier Setup (HMS) are documented in this file, which is (mostly) AI-generated and (always) human-edited. Dependency updates may or may not be called out specifically.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-13

### Added

* Added an introduction where the CLI starts on a terminal

### Changed

* Minified pages on worker threads, in parallel, and measured what options contribute in fewer rounds, which cuts the time without the render check by about a third on sample pages
* Checked options to keep or skip before reading pages and starting the browser
* Made HTML Minifier’s equivalence check development-only, as it only ran next to an HTML Minifier checkout: The report no longer says “Not equivalence-checked,” `--no-equivalence` is no longer listed, and `loadEquivalence` is no longer exported

### Fixed

* Read starting configurations as HTML Minifier does: with a byte order mark, and, without a `.json` extension, as JSON or else as module
* Carried input handling options (e.g., `caseSensitive`) of a preset a starting configuration names
* Named options presets include in a form that doesn’t fit (e.g., full whitespace collapsing where only `preserveLineBreaks` fits)

## [0.1.0] - 2026-11-13

### Added

* Released first version