---
version: 1
slug: "android-app-src-main-kotlin-com-recall-voice-ui"
primary_target: "android/app/src/main/kotlin/com/recall/voice/ui"
related_targets: []
---

# Surface brief: Recall Android app

Scope: the three native screens in `android/app/src/main/kotlin/com/recall/voice/ui` (deck browser, review session, settings). Visitor mode: Operate.

Audience and job: Samuel reviewing his own cards, half hands-free in the car (screen glanced at arm's length, day or night) and half in hand reading dense content. Task: start a session, hear or read the question, reveal the answer, rate 1–4, and trust that the rating was saved. Constraints: Material 3 components and navigation, system Back, 48 dp targets, state never by colour alone, Spanish and English.

Chosen direction: Línea nocturna (the user's pick from the second hand; fused from the catalog world "midnight transit diagram"). Memorable moment: the session line fills with the colours of the ratings you gave, station by station.

Unresolved: Markdown rendering covers text, emphasis, code and lists only; formulas and images still show as source. Stats and leeches have no screen yet.

## Direction contract

THESIS: A review session is a line and every card a station; you always see how many stops remain. Refuses the category default of a grey flashcard with four identical buttons.

OWN-WORLD: Midnight-blue enamel ground (porcelain-white ground in light theme, the printed pocket map), porcelain station ticks, four line inks: scarlet, amber, green, cobalt, each bound to one rating and to nothing else. Encode Sans throughout; labels in semi-condensed tracked caps, numbers tabular. Thick rounded line strokes, round interchange rings, tonal porcelain cards, no shadows.

STORY: He knows where he is in the session, hears or reads the card, and answers with one of four numbered roundels; the stop he just left keeps the colour of his answer.

FIRST VIEWPORT: Session screen. Top bar: back, deck name, "7 / 23". Under it the session line across the full width: passed stations coloured by rating, the current one an interchange ring, the rest porcelain ticks. Centre: the card on a porcelain panel, question then answer, scrollable. Below: one status line with icon, then four roundels 1–4 with name and next interval; before the answer, one wide "show answer" button in their place.

FORM: Midnight transit diagram, a dealt challenger chosen by the user over the assigned direction. seed:5b356c2675e335dd

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
