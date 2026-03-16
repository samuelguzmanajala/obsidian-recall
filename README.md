# Obsidian Recall

A modern spaced repetition plugin for [Obsidian](https://obsidian.md/) powered by the FSRS algorithm.

## Why?

The existing spaced repetition plugin (500k+ downloads) has known limitations:
- Uses SM-2, an outdated algorithm from 1987
- Performance degrades with large card collections
- No leech detection or learning diagnostics
- No flashcard generation

Recall aims to fix all of that.

## Planned Features

- 🧠 **FSRS algorithm** via [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) — the same algorithm Anki adopted
- ⚡ **Efficient indexing** — no full vault re-scan on every session
- 📊 **Built-in diagnostics** — leech detection, retention rate, weak spots
- 🤖 **Flashcard generation** — select text → generate cloze/context cards (LLM)
- 📈 **Real statistics** — retention rate, time per card, weekly trends

## Stack

- TypeScript
- Obsidian Plugin API
- ts-fsrs

## Status

🚧 Early development
