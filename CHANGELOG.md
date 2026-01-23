# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog relates to the VS Code Extension for the Mojo language. Changelogs for the Mojo project can be found at: [Mojo release changelog](https://docs.modular.com/mojo/changelog)

## [Unreleased]

- Added: Option to filter out diagnostics in docstrings (#38) - Thanks @mzaks!

## [26.0.3] - 2025-12-05

- Fix: Resolve remaining issues with `CONDA_PREFIX` that prevented use of `mojo debug --vscode` (#33)

## [26.0.2] - 2025-12-03

- Fix: Debugger fails to launch in some environments due to issues with `CONDA_PREFIX` (#28)
- Fix: Incorrect install link in README (#27)
- Change: Improvements to README (#30)
- Change: Added `comptime` keyword syntax support (#32)

## [26.0.1] - 2025-09-29

- Change: Added LICENSE file

## [26.0.0] - 2025-09-22

Moved extension to standalone repository with independent release schedule