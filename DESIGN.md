---
name: Recall
description: Spaced-repetition review as a night transit line; every card a station, every rating an ink.
colors:
  midnight: "#0B1230"
  midnight-low: "#111A40"
  midnight-raised: "#172052"
  midnight-high: "#1E2962"
  midnight-highest: "#263272"
  midnight-seam: "#34407A"
  porcelain: "#F4F6FB"
  porcelain-dim: "#B9C1E8"
  porcelain-rule: "#C5CBE3"
  ink-muted: "#4A5385"
  paper-white: "#FFFFFF"
  day-low: "#EDF0F9"
  day-container: "#E4E8F5"
  day-high: "#DCE2F5"
  day-highest: "#D3DAF0"
  outline-night: "#7C88BD"
  outline-day: "#6B76A8"
  card-code-night: "#E3E8F6"
  card-code-day: "#EDF0F9"
  card-mark: "#FFE08A"
  ink-again: "#E5322D"
  ink-hard: "#FFB000"
  ink-good: "#178F4B"
  ink-easy: "#2F6BFF"
  error-night: "#FF8A80"
  error-day: "#B3211C"
  error-container-night: "#5A1512"
  on-error-container-night: "#FFDAD6"
  error-container-day: "#FFDAD6"
  on-error-container-day: "#410002"
typography:
  display-small:
    fontFamily: "Encode Sans"
    fontSize: "36sp"
    fontWeight: 800
    lineHeight: "42sp"
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  headline-large:
    fontFamily: "Encode Sans"
    fontSize: "30sp"
    fontWeight: 800
    lineHeight: "36sp"
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
  headline-medium:
    fontFamily: "Encode Sans"
    fontSize: "26sp"
    fontWeight: 700
    lineHeight: "32sp"
    letterSpacing: "-0.005em"
    fontFeature: "tnum"
  headline-small:
    fontFamily: "Encode Sans"
    fontSize: "24sp"
    fontWeight: 700
    lineHeight: "31sp"
    fontFeature: "tnum"
  title-large:
    fontFamily: "Encode Sans"
    fontSize: "22sp"
    fontWeight: 700
    lineHeight: "30sp"
    fontFeature: "tnum"
  title-medium:
    fontFamily: "Encode Sans"
    fontSize: "18sp"
    fontWeight: 600
    lineHeight: "24sp"
    fontFeature: "tnum"
  title-small:
    fontFamily: "Encode Sans"
    fontSize: "15sp"
    fontWeight: 600
    lineHeight: "20sp"
    fontFeature: "tnum"
  body-large:
    fontFamily: "Encode Sans"
    fontSize: "17sp"
    fontWeight: 500
    lineHeight: "25sp"
    fontFeature: "tnum"
  body-medium:
    fontFamily: "Encode Sans"
    fontSize: "15sp"
    fontWeight: 500
    lineHeight: "22sp"
    fontFeature: "tnum"
  body-small:
    fontFamily: "Encode Sans"
    fontSize: "13sp"
    fontWeight: 500
    lineHeight: "18sp"
    fontFeature: "tnum"
  label-large:
    fontFamily: "Encode Sans"
    fontSize: "16sp"
    fontWeight: 700
    lineHeight: "20sp"
    fontFeature: "tnum"
  label-medium:
    fontFamily: "Encode Sans"
    fontSize: "14sp"
    fontWeight: 600
    lineHeight: "18sp"
    fontFeature: "tnum"
  label-small:
    fontFamily: "Encode Sans"
    fontSize: "13sp"
    fontWeight: 700
    lineHeight: "16sp"
    letterSpacing: "0.08em"
    fontVariation: "'wdth' 87.5"
  code:
    fontFamily: "monospace"
    fontSize: "15sp"
    lineHeight: "22sp"
rounded:
  extra-small: "6dp"
  small: "10dp"
  medium: "14dp"
  large: "18dp"
  extra-large: "28dp"
  full: "50%"
spacing:
  "4": "4dp"
  "8": "8dp"
  "12": "12dp"
  "16": "16dp"
  "20": "20dp"
  "24": "24dp"
components:
  shell-top-bar:
    backgroundColor: "{colors.midnight}"
    textColor: "{colors.porcelain}"
    typography: "{typography.title-large}"
  session-line-track:
    backgroundColor: "{colors.midnight-seam}"
    height: "8dp"
  card-panel-night:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.midnight}"
    typography: "{typography.headline-small}"
    rounded: "{rounded.large}"
    padding: "22dp"
  card-panel-day:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.midnight}"
    typography: "{typography.headline-small}"
    rounded: "{rounded.large}"
    padding: "22dp"
  rating-roundel-again:
    backgroundColor: "{colors.ink-again}"
    textColor: "{colors.paper-white}"
    typography: "{typography.headline-large}"
    rounded: "{rounded.full}"
    size: "64dp"
  rating-roundel-hard:
    backgroundColor: "{colors.ink-hard}"
    textColor: "{colors.midnight}"
    typography: "{typography.headline-large}"
    rounded: "{rounded.full}"
    size: "64dp"
  rating-roundel-good:
    backgroundColor: "{colors.ink-good}"
    textColor: "{colors.paper-white}"
    typography: "{typography.headline-large}"
    rounded: "{rounded.full}"
    size: "64dp"
  rating-roundel-easy:
    backgroundColor: "{colors.ink-easy}"
    textColor: "{colors.paper-white}"
    typography: "{typography.headline-large}"
    rounded: "{rounded.full}"
    size: "64dp"
  button-primary-night:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.midnight}"
    typography: "{typography.title-medium}"
    rounded: "{rounded.large}"
    height: "64dp"
  button-primary-day:
    backgroundColor: "{colors.midnight}"
    textColor: "{colors.porcelain}"
    typography: "{typography.title-medium}"
    rounded: "{rounded.large}"
    height: "64dp"
  button-outlined-night:
    textColor: "{colors.porcelain}"
    typography: "{typography.title-small}"
    rounded: "{rounded.large}"
    height: "56dp"
  button-outlined-day:
    textColor: "{colors.midnight}"
    typography: "{typography.title-small}"
    rounded: "{rounded.large}"
    height: "56dp"
  button-show-answer-night:
    backgroundColor: "{colors.midnight-raised}"
    textColor: "{colors.porcelain}"
    typography: "{typography.title-large}"
    rounded: "{rounded.large}"
    height: "120dp"
  button-show-answer-day:
    backgroundColor: "{colors.day-container}"
    textColor: "{colors.midnight}"
    typography: "{typography.title-large}"
    rounded: "{rounded.large}"
    height: "120dp"
  banner-stale-night:
    backgroundColor: "{colors.midnight-raised}"
    textColor: "{colors.porcelain}"
    typography: "{typography.body-medium}"
    rounded: "{rounded.medium}"
    padding: "14dp 16dp"
  banner-stale-day:
    backgroundColor: "{colors.day-container}"
    textColor: "{colors.midnight}"
    typography: "{typography.body-medium}"
    rounded: "{rounded.medium}"
    padding: "14dp 16dp"
  banner-rejected-night:
    backgroundColor: "{colors.error-container-night}"
    textColor: "{colors.on-error-container-night}"
    typography: "{typography.body-medium}"
    rounded: "{rounded.medium}"
    padding: "14dp 16dp"
  banner-rejected-day:
    backgroundColor: "{colors.error-container-day}"
    textColor: "{colors.on-error-container-day}"
    typography: "{typography.body-medium}"
    rounded: "{rounded.medium}"
    padding: "14dp 16dp"
  deck-row:
    textColor: "{colors.porcelain}"
    typography: "{typography.body-large}"
    height: "56dp"
  column-head:
    textColor: "{colors.porcelain-dim}"
    typography: "{typography.label-small}"
    width: "64dp"
---

# Design System: Recall

Scope: the native Android app in `android/` (Kotlin, Jetpack Compose, Material 3). The Obsidian plugin in this repository (`styles.css`, `src/app/frontend`) follows Obsidian's own theme and is not part of this system.

Source of truth: `android/app/src/main/kotlin/com/recall/voice/ui/theme/Theme.kt`. Every value below is read from the shipped code; where this file and the code disagree, the code is right and this file is stale.

## Overview

**Creative North Star: "Línea nocturna"**

A review session is a transit line seen at night and every card is a station on it. The top of every screen is a slab of midnight enamel carrying the name of where you are; on the session screen the line runs across that enamel, and each stop you leave keeps the ink of the rating you gave it. The four ratings are the four line inks, and the same four inks sit below the card as numbered roundels, so the answer you tap and the mark it leaves on the line are visibly the same thing.

The system is built for two situations: a phone glanced at from arm's length in a car, by day or by night, and a phone held in the hand to read dense cards. So the type is heavy and large, the controls are tall, contrast between ground and text is high, and nothing that matters is told by colour alone. The card is the only bright panel on the session screen and nothing competes with it.

Everything else is ordinary Material 3: stock buttons, outlined fields, segmented buttons, switch, top app bar and system Back, re-tinted by the scheme and never restyled by hand. The world lives in the shell, the line, the inks and the type, and does not need custom widgets to be recognised.

**Key Characteristics:**
- Midnight shell on every screen in both themes; only the content ground under it changes.
- Four inks, four ratings, one meaning each.
- Lines are thick, round-capped strokes; stations are discs, rings and ticks drawn on a canvas.
- One typeface (Encode Sans, variable), weights 500 to 800, tabular figures.
- Flat: depth is tone and keyline, never shadow.
- State is always carried by shape or words as well as colour.
- Spanish and English from string resources, following the system language.

## Colors

A two-tone enamel palette, midnight blue and porcelain white with a faint blue cast, plus four saturated line inks that appear only where a rating is meant.

### Primary
- **Midnight Enamel** (#0B1230): the shell (top bar, session line strip, status bar area, window background, launcher background) in both themes; the content ground in the night theme; all text and the primary button in the day theme.
- **Porcelain** (#F4F6FB): text, icons, station ticks and interchange rings on midnight; the card panel and the primary button in the night theme; the content ground in the day theme.

### Secondary (the line inks)
- **Scarlet** (#E5322D): rating 1, Again.
- **Amber** (#FFB000): rating 2, Hard. The only ink whose numeral is midnight; the other three carry white.
- **Green** (#178F4B): rating 3, Good.
- **Cobalt** (#2F6BFF): rating 4, Easy.

### Tertiary (status)
- **Signal Coral** (#FF8A80 night) / **Signal Red** (#B3211C day): error text and the error icon. Always with an icon and a sentence.
- **Error container** (#5A1512 with #FFDAD6 text at night; #FFDAD6 with #410002 text by day): the rejected-reviews banner on the home screen.

### Neutral
- **Midnight Raised** (#172052): night container tone: banners, the show-answer fill, the selected segment, skeleton blocks.
- **Midnight Seam** (#34407A): the bare track of the session line and night dividers and deck-tree lines.
- **Midnight Low / High / Highest** (#111A40, #1E2962, #263272): the remaining night container steps, used only by Material components.
- **Porcelain Dim** (#B9C1E8): secondary text and status icons on midnight.
- **Porcelain Rule** (#C5CBE3): the rule between question and answer on the card, the card keyline in the day theme, day dividers and deck-tree lines.
- **Muted Ink** (#4A5385): secondary text on porcelain and on the card; list markers in card text.
- **Paper White** (#FFFFFF): the card panel in the day theme, and the numeral on scarlet, green and cobalt.
- **Day containers** (#EDF0F9, #E4E8F5, #DCE2F5, #D3DAF0): the day container steps; #E4E8F5 is the day banner, show-answer and skeleton tone, #DCE2F5 the selected segment.
- **Outline** (#7C88BD night, #6B76A8 day): field and outlined-button strokes, and zero counts in the deck list.
- **Card code** (#E3E8F6 night, #EDF0F9 day) and **card mark** (#FFE08A): backgrounds for code and for highlighted text inside a card.

### Named Rules
**The Four Inks Rule.** Scarlet, amber, green and cobalt each mean one rating (Again, Hard, Good, Easy) and nothing else. They are never used for emphasis, errors, links, success, branding accents or decoration inside the app. Errors have their own coral and red.

**The Roundel Rule.** A numeral inside an ink disc is the 1 to 4 rating key, the number you say or tap. Any other number shown with an ink (a count, a total) sits beside the ink, never inside it.

**The Constant Shell Rule.** The shell is midnight with porcelain text in the night theme and in the day theme. Switching theme changes the content ground and the card (midnight ground with a porcelain card at night; porcelain ground with a white, keylined card by day) and nothing above them. The session line is always drawn on midnight.

**The Never By Colour Alone Rule.** Every state has a second carrier. On the line: confirmed is a filled dot with a full-width inked segment; still saving is a hollow ring with a thin segment; rejected is a porcelain dot cut by a midnight slash with its segment left as bare track. Elsewhere: an icon plus a sentence. A rating always shows its numeral and its name with the ink.

## Typography

**Display Font:** Encode Sans, variable (`res/font/encode_sans.ttf`), weight and width axes
**Body Font:** Encode Sans
**Label Font:** Encode Sans at 87.5 width (semi-condensed), for tracked capitals
**Code:** the platform monospace, only for code inside card content

**Character:** One signage face used at heavy weights, the way a transit authority letters its stations. Body text starts at weight 500, not 400, so it holds at arm's length on both grounds.

### Hierarchy
- **Display** (800, 36sp/42sp, -0.01em): defined in the theme; no shipped screen uses it yet.
- **Headline large** (800, 30sp/36sp, -0.01em): the numeral in a rating roundel; the session-complete title.
- **Headline medium** (700, 26sp/32sp): the one summary line per screen ("21 cards due"), and the titles of empty and error states.
- **Headline small** (700, 24sp/31sp): the question on the card; counts in the end-of-session tally.
- **Title large** (700, 22sp/30sp): the top bar title, the "7 / 23" counter, the show-answer label; at weight 500, the answer on the card.
- **Title medium** (600, 18sp/24sp): primary button labels, status sentences, section headings, the next interval under a roundel, non-zero counts.
- **Title small** (600, 15sp/20sp): labels of outlined and tonal buttons in settings.
- **Body large** (500, 17sp/25sp): deck names, setting names, explanatory text.
- **Body medium** (500, 15sp/22sp): supporting text, banners, hints.
- **Body small** (500, 13sp/18sp): raw technical detail under an error.
- **Label medium** (600, 14sp/18sp): rating names under roundels and in the tally.
- **Label small** (700, 13sp/16sp, 0.08em, semi-condensed, uppercase): column heads over the count columns of the deck list.

### Named Rules
**The Tabular Rule.** Figures are tabular everywhere (`tnum` on every style of the main cut), so counts align in columns and the session counter does not shift as it advances.

**The Column Head Rule.** Tracked semi-condensed capitals appear in one place: the heads of numeric columns in a list. They are not placed above headings or used to label sections; section headings are title medium in sentence case.

**The Scale With The Reader Rule.** All type is in sp and every container that holds text takes a minimum height, not a fixed one, so the layout survives a 130% system font scale without clipping.

## Layout

A single column on every screen, edge to edge, with content padded 16dp on the session screen, 20dp on the home and settings screens, and 24dp in centred empty, error and done states. Spacing steps observed in the build are 4, 8, 12, 16, 20 and 24dp; 12dp is the usual gap between stacked blocks and between an icon and its sentence.

The session screen is a fixed stack: shell (top bar plus the 44dp line strip), the card panel taking all remaining height and scrolling inside itself, a status area, and the controls. The status area reserves a minimum of 104dp and the controls a minimum of 132dp in every phase, so the card does not move when the answer is revealed, when the session pauses, or when a rejection notice appears. The controls' minimum is computed from the line heights of the two text styles under a roundel, so it grows with the font scale.

The home screen is a list: a summary line, a detail line, one full-width primary button, optional banners, then the deck tree. Each deck row is at least 56dp tall, indents 20dp per level, and ends in two right-aligned count columns of 64dp each, whose heads share the same widths.

Touch targets are at least 48dp; primary actions are 56 to 64dp tall and full width; the show-answer button fills the whole controls area.

## Elevation & Depth

Flat. No shadow or elevation value is set anywhere in the interface code. Layers are parted by tone (the porcelain card on midnight, raised midnight containers, pale containers on porcelain) and, where tone is not enough, by a keyline: the 1dp porcelain-rule edge on the white day card, the 3dp and 4dp porcelain strokes around the show-answer button and the roundels, and a 1.5dp midnight keyline around each station dot so it stays distinct from a segment in the same ink.

### Named Rules
**The No Shadow Rule.** Nothing casts a shadow. If a surface needs to separate from its ground, change its tone or give it a keyline.

## Shapes

Generously rounded rectangles and true circles. Corners step 6, 10, 14, 18 and 28dp: 18dp for the card panel and every full-width button, 14dp for banners and the tap area of a rating cell, 10dp for code blocks inside a card, 6dp for skeleton bars. Roundels, station dots, interchange rings and tally dots are circles. Material's own segmented buttons and switch keep their stock pill shapes, and outlined fields keep the stock field shape.

Lines are drawn, not bordered: 8dp for the session track and confirmed segments, 3dp for a segment still being saved, 4dp for the deck-tree lines, 2.5dp for ticks, slashes and pending rings, all with round caps except inked segments, which butt against their stations. The deck tree turns at right angles. An interchange is a ring: a porcelain disc with a midnight centre.

## Components

### Shell top bar
- **Style:** midnight container with porcelain title, navigation icon and action icons, in both themes. Title in title large, one line.
- **Content:** the screen or deck name; on the session screen the "7 / 23" counter sits at the end in the same style.
- **Status bar:** transparent with light icons in both themes, so the midnight runs to the top edge.

### Session line (signature)
- **Placement:** a 44dp strip directly under the top bar on the session screen, on midnight.
- **Track:** 8dp round-capped midnight-seam line across the width.
- **Stations:** passed stations are 6.5dp-radius dots; the current station is an interchange ring (13dp radius porcelain, 7dp midnight centre); stations ahead are 2.5dp porcelain ticks.
- **Ink:** each passed segment takes the ink of the rating given at the station it leaves.
- **Save state:** confirmed, pending and rejected are distinguished by shape as set out in the Never By Colour Alone Rule; counts of pending and rejected are also spoken in the content description.
- **Density:** stations are never closer than 22.5dp; longer sessions show a sliding window with the track running off the edge.
- **Motion:** the ring slides to the next station over 320ms; while the app is listening, a porcelain halo expands from the ring and fades over 1400ms, repeating.

### Card panel
- **Corner Style:** 18dp.
- **Background:** porcelain at night; white with a 1dp porcelain-rule keyline by day. Text is midnight in both.
- **Internal Padding:** 22dp; scrolls inside itself.
- **Content:** question in headline small; after reveal, a 2dp porcelain-rule divider with 20dp above and below, then the answer in title large at weight 500. Blocks are 12dp apart. Bold is weight 800; code sits on the card-code tone in monospace, block code in a 10dp-cornered panel that scrolls sideways; highlights sit on card mark. Text is selectable.

### Rating roundels
- **Shape:** 64dp circle: a 4dp ring in the ground's text colour around a disc of the rating's ink.
- **Numeral:** 1 to 4 in headline large; midnight on amber, white on the others.
- **Caption:** the rating's name in label medium (muted), then the next interval in title medium.
- **Layout:** four equal cells, 8dp apart, each cell a tap target with a 14dp-cornered ripple.
- **Submitting:** the three roundels not chosen dim to 35% opacity and all four stop accepting taps; the status sentence says the review is being saved.

### Buttons
- **Shape:** 18dp corners, full width.
- **Primary:** Material filled button: porcelain with midnight text at night, midnight with porcelain text by day; label in title medium; minimum height 56 to 64dp. One per screen.
- **Outlined:** Material outlined button for secondary actions; label in title small or title medium; minimum height 56dp.
- **Tonal:** Material filled tonal button, used once, for granting the microphone.
- **Show answer:** outlined with a 3dp stroke in the ground's text colour on a container fill, label in title large, filling the controls area (120dp at the default font scale, growing with it).
- **States:** Material's stock pressed, focused and disabled treatments.

### Status and notices
- **Status row:** a 24dp icon in the muted tone, 12dp gap, one sentence in title medium. One sentence per phase (reading, listening, paused, saving).
- **Rejection notice:** the same row in the error colour with an error-outline icon, stating how many reviews the server rejected.
- **Banners:** 14dp-cornered tonal panels with an icon and body-medium text: container tone for stale data, error container for rejected reviews.
- **Inline results:** icon or small spinner plus a sentence, announced as a polite live region.

### Deck list
- **Row:** at least 56dp; deck name in body large, up to two lines; two 64dp count columns. Non-zero counts in title medium; zeros drop to body weight and the outline tone.
- **Tree line:** a 4dp round-capped line in the divider tone joins rows at right angles. Root decks are interchange rings (8dp radius, 4dp centre); child decks are 5dp-radius dots. Lines continue past rows that still have siblings below.
- **Expand and collapse:** a chevron icon button in the row; the row itself starts a session.
- **Loading:** a skeleton of the same layout in the container tone, pulsing between 55% and 100% opacity every 900ms.

### Inputs and choices
- **Fields:** Material outlined text fields with a floating label, full width.
- **Segmented buttons:** Material single-choice rows, minimum 48dp tall; the selected segment carries a check mark as well as the container tone.
- **Switch row:** name and description at the start, switch at the end; the whole row (minimum 72dp) toggles.
- **Sections:** a title-medium heading, with a 1dp divider in the divider tone between sections.

### Launcher icon
- A line bending at 45 degrees through an interchange ring on midnight, with porcelain terminal dots (`res/drawable/ic_launcher_foreground.xml`).

## Do's and Don'ts

### Do:
- **Do** take every colour from the theme (`Recall.colors` for the shell, card and inks; `MaterialTheme.colorScheme` for everything on the content ground). No colour literals in screens.
- **Do** get a rating's colour from `Recall.colors.ink(rating)` and its numeral colour from `onInk(rating)`, and show the numeral and the rating's name with it.
- **Do** keep the shell midnight with porcelain content in both themes, and draw anything that carries inks as a line on that shell.
- **Do** give every state a shape, icon or sentence as well as a colour: hollow ring for pending, slashed dot for rejected, a written notice for failures.
- **Do** size controls with a minimum height (`heightIn(min = ...)`, 48dp or more; 56 to 64dp for primary actions) so they grow with the font scale.
- **Do** put every visible and spoken string in `res/values/strings.xml` and `res/values-es/strings.xml`, with plurals where a count is involved.
- **Do** use Material 3 components as they come and let the scheme, type scale and shapes tint them.
- **Do** separate layers with tone or a keyline.

### Don't:
- **Don't** use scarlet, amber, green or cobalt for anything that is not one of the four ratings.
- **Don't** put a count or any other number inside an ink disc; a numeral in ink is the 1 to 4 rating key.
- **Don't** add shadows or elevation.
- **Don't** let the shell follow the theme; only the content ground and the card switch.
- **Don't** signal a state by colour or opacity alone.
- **Don't** fix the height of anything that holds text.
- **Don't** write interface text in code.
- **Don't** set tracked capitals anywhere but the heads of numeric list columns.
- **Don't** introduce a second typeface; monospace is for code inside card content only.
