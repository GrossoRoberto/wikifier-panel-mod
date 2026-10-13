# Changelog

## 0.6.0

First public release, as `wiki-tree`. The mod was previously a private plugin called `albero-wiki` (same 0.6.0 code base).

- Renamed `albero-wiki` to `wiki-tree`; the command is now `/wiki-tree`.
- Everything translated to English: panel text, toasts, identifiers, comments and tests.
- Report recognition is bilingual (English and Italian), so the colours work whatever `language` is set in `infowiki.md`.
- Added screenshots of the four tabs and the tested install commands to the README.
- Stored state (the "seen" marks) starts empty: the old `albero-wiki` keys are not migrated, so on first open all pages count as seen once.
