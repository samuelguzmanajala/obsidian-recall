# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

Scope note: this record covers the Recall product. The Android app (`android/`) is the
native surface. The Obsidian plugin (`src/app/frontend`) is a web-technology surface that
lives inside Obsidian and follows Obsidian's own theme; it is not redesigned from here.

## Users

Samuel, the author, studying his own Obsidian vault with spaced repetition. Today it is a
personal tool for one user and one vault. He wants it to be publishable later (plugin +
backend + app), so first use must be understandable without his help, even though setup can
stay technical for now.

Usage is split about evenly between two situations:

- Driving, hands-free: the session is run by voice and the screen is only glanced at.
- In hand (sofa, transport): he reads the card on screen and taps.

## Product Purpose

Recall turns notes written in Obsidian into flashcards and schedules them with FSRS. The
Android app lets him review those cards away from the computer, by voice or by touch,
without Obsidian being open. Success is a daily review habit that survives being in the car
or away from the desk, with every rating saved exactly once.

## Positioning

The cards are the user's own Markdown notes, which stay editable in the vault, and a
self-hosted backend is the single authority for scheduling. The mobile client can run a
whole review hands-free: it reads the question, listens, reads the answer and takes the
rating by voice.

## Operating Context

- Cards are written in Obsidian Markdown; the plugin publishes notes to the backend.
- The backend (Node 24 + SQLite) runs on the user's Mac and is reached over a private
  network; the phone needs a server URL and a token.
- In the car, audio goes through Bluetooth; question and answer are spoken by cloud TTS
  with on-device TTS as fallback, and ratings are spoken as 1–4 or words.
- Card content is broad: technical concepts (with code, lists, tables), languages,
  general knowledge, philosophy, political science, economics, trading, and cards with
  formulas or images that voice cannot read.

## Capabilities and Constraints

- Decks form a tree with due, new and total counts; a session can cover all decks or one.
- Four ratings (Again, Hard, Good, Easy), each with a preview of the next interval.
- Study is online only. A rating is never shown as saved without server acknowledgement;
  rejected reviews are archived locally and reported, not silently dropped.
- An unrecognised spoken rating pauses the session; it never becomes a rating.
- The server exposes stats and leeches; the Android app does not show them yet.
- Android: Kotlin, Jetpack Compose, Material 3, minSdk 26.
- Undecided: offline study, background/locked-screen sessions, stable card IDs.

## Brand Commitments

- The app is named **Recall** (previously "Recall Voice"; it is no longer voice-only).
- Interface in Spanish and English, following the system language.
- No logo, palette or typeface has been made binding.

## Evidence on Hand

- Working backend, plugin and Android app in this repository; `docs/backend.md` and
  `docs/macos-deployment.md` describe the verified personal deployment.
- No screenshots, visual goldens, logo or brand assets exist.
- No other users, testimonials or usage data; none may be invented.

## Product Principles

1. The voice session must be completable without looking at or touching the screen.
2. Never claim a review was saved when it was not; show conflicts and failures plainly.
3. The card's content is the point; the interface gets out of its way in both situations.
4. The vault stays the source of the cards; the app reviews, it does not edit.
5. Understandable on first use without the author explaining it.

## Accessibility & Inclusion

Glanceable while driving: large touch targets, high contrast, and state that is readable
at arm's length and not conveyed by colour alone.
