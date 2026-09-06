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

  // Collapse repeated spaces / newlines
  s = s.replace(/\s+/g, ' ');

  return s.trim();
}
