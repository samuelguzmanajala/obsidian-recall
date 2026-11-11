/**
 * Final text normalization right before sending to a TTS engine.
 * Runs AFTER markdownToVoice (which strips markdown). Handles things
 * that are valid plain text but sound awful when synthesized literally.
 *
 * Pure function. No external deps.
 */
export function preprocessForTts(text: string): string {
  let s = text;

  // Runs of underscores → ellipsis (TTS reads as a brief, natural pause).
  // Cards use "___" for fill-in-the-blank, so a pause lets the listener
  // mentally fill the gap without breaking the sentence flow.
  s = s.replace(/_{2,}/g, ' … ');

  // Stray single underscores between letters/digits get spoken oddly too
  s = s.replace(/(?<=\w)_(?=\w)/g, ' ');

  s = spokenPunctuation(s);

  // Collapse repeated spaces / newlines
  s = s.replace(/\s+/g, ' ');

  return s.trim();
}

/** A pause inserted by the rules below; resolved to ", " (or dropped) by `resolvePauses`. */
const PAUSE = '';

/**
 * Symbols a reader turns into pauses, done deterministically: quotes that only wrap a term
 * are dropped, a spaced "( aside )" becomes a comma aside, and spaced arrows and slashes
 * become commas. Anything attached to a word (f(x), km/h, a->b, don't) is left alone, and
 * so are nested or unbalanced parentheses. Nothing is translated, expanded or reordered.
 */
export function spokenPunctuation(text: string): string {
  let s = unquote(text);
  s = unparenthesise(s);
  s = s.replace(/(?<=^|\s)(?:→|->|=>|⇒)(?=\s|$)/g, PAUSE);
  s = s.replace(/(?<=[^\s/])\s+\/\s+(?=[^\s/])/g, ` ${PAUSE} `);
  return resolvePauses(s);
}

const QUOTE_PAIRS = [/"([^"\n]*)"/g, /„([^„“”\n]*)[“”]/g, /“([^“”\n]*)”/g];

/** Quotes are paired left to right; a pair goes only when it wraps a whole term or phrase. */
function unquote(text: string): string {
  let s = text;
  for (const re of QUOTE_PAIRS) {
    s = s.replace(re, (m: string, inner: string, at: number, all: string) => {
      const prev = all[at - 1];
      const next = all[at + m.length];
      const wraps = inner !== '' && inner === inner.trim()
        && (prev === undefined || /[\s(¿¡[]/.test(prev))
        && (next === undefined || /[\s.,;:!?…)\]]/.test(next));
      return wraps ? inner : m;
    });
  }
  return s;
}

/** Only un-nested groups opened after whitespace (or at the start) and not glued to a following word. */
function unparenthesise(text: string): string {
  const groups: Array<[number, number]> = [];
  let depth = 0, open = -1, nested = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') {
      if (depth++ === 0) { open = i; nested = false; } else nested = true;
    } else if (text[i] === ')' && depth > 0) {
      if (--depth === 0 && !nested) groups.push([open, i]);
    }
  }
  let s = text;
  for (const [o, c] of groups.reverse()) {
    if (o > 0 && !/\s/.test(s[o - 1])) continue;
    if (c + 1 < s.length && !/[\s.,;:!?…]/.test(s[c + 1])) continue;
    const inner = s.slice(o + 1, c).trim();
    s = s.slice(0, o) + (inner ? ` ${PAUSE} ${inner} ${PAUSE} ` : ' ') + s.slice(c + 1);
  }
  return s;
}

/**
 * A pause is a comma only between words. Next to punctuation, at either end or after a
 * symbol ("+", "=", "…") it is dropped, so no ", ,", ",.", ", ?" or leading comma appears.
 */
function resolvePauses(text: string): string {
  return text.replace(/\s*(?:\s*)*\s*/g, (m: string, at: number, all: string) => {
    const prev = all[at - 1];
    const next = all[at + m.length];
    if (prev === undefined || next === undefined || /[¿¡([{]/.test(prev)) return '';
    if (/[,.;:!?)\]}]/.test(next)) return '';
    if (next === '…' || !/[\p{L}\p{N}\p{M}%'’"”»)\]]/u.test(prev)) return ' ';
    return ', ';
  });
}
