/**
 * Convert markdown content to a TTS-friendly plain-text representation.
 * Used by the voice API so the mobile client can hand the result straight
 * to TextToSpeech without the synthesizer reading literal asterisks,
 * brackets, or backticks.
 *
 * Pure function. No external deps — regex-only.
 */
export function markdownToVoice(md: string): string {
  let s = md.trim();
  if (s === '') return '';

  // Code fences: ```lang\n...\n``` → "(código)" (TTS reads code badly)
  s = s.replace(/```[\s\S]*?```/g, ' (código) ');

  // HTML tags: drop them
  s = s.replace(/<[^>]+>/g, '');

  // Wikilinks: [[target|alias]] → alias ; [[target]] → target
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1');

  // Markdown links: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Inline code: `x` → x
  s = s.replace(/`([^`]+)`/g, '$1');

  // Bold/italic: **x**, __x__, *x*, _x_ → x
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '$1');
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?!_)/g, '$1');

  // Headers: leading # at start of line → drop
  s = s.replace(/^\s*#{1,6}\s+/gm, '');

  // List bullets: leading -, *, + or "1. " at start of line → drop
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');

  // Blockquotes: leading > at start of line → drop
  s = s.replace(/^\s*>\s?/gm, '');

  // Multiple newlines → period + space (helps TTS phrasing)
  s = s.replace(/\n{2,}/g, '. ');
  s = s.replace(/\n+/g, '. ');

  // Collapse whitespace
  s = s.replace(/[ \t]+/g, ' ');

  // Tidy up doubled punctuation introduced by the line-break replacement
  s = s.replace(/\.\s*\.\s*/g, '. ');
  s = s.replace(/\s+([,.;:!?])/g, '$1');

  return s.trim();
}
