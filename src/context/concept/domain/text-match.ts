/**
 * Comparison form for text search over card sides: Unicode compatibility-decomposed, without
 * combining marks (accents), lower-cased, whitespace runs collapsed to one space and trimmed.
 * So "Adiós" matches "adios" and "Müller" matches "muller"; "ß" is kept as is.
 */
export function foldText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when `folded` (already passed through `foldText`, non-empty) occurs in either side. */
export function sidesContain(sideA: string, sideB: string, folded: string): boolean {
  return folded.length > 0 && (foldText(sideA).includes(folded) || foldText(sideB).includes(folded));
}
