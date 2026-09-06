# Obsidian Recall

## Standalone backend

Recall can now run as an independent service. The Obsidian plugin and Android app
connect to the same backend; Obsidian does not need to stay open for mobile reviews.

The server owns Markdown parsing, decks, FSRS scheduling, daily limits, review history
and optional cloud speech. SQLite transactions combine state, history and persistent
idempotency receipts. Optimistic revisions reject stale device commands.

See **[Backend setup, safe migration and protocol](docs/backend.md)** before enabling
remote mode. Existing installations stay in legacy local mode until explicitly switched.
Do not run local and remote scheduling as parallel authorities.

```sh
npm ci
npm run build:server
# Create a private .env from .env.example and set RECALL_TOKEN first.
node --env-file=.env dist/server/main.cjs
```

Requires Node 24. Validate changes with `npm run typecheck`, `npm run test:run`,
`npm run build`, and `npm run build:server`. Android: `cd android && ./gradlew
:app:testDebugUnitTest :app:assembleDebug` (JDK 17 or 21 and Android SDK required).

### Scope of this version

- One user/vault, one primary backend, multiple online clients.
- Optional Obsidian publisher; Markdown remains editable in the vault.
- Explicit conflict detection, not automatic Markdown merging or offline study.
- Existing local mode is retained for migration; new server guarantees apply in remote mode.
- Daily boundary uses the backend timezone (`TZ`, default Europe/Madrid in Compose).

## Original plugin overview

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
