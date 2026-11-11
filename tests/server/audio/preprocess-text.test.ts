import { describe, it, expect } from 'vitest';
import { preprocessForTts } from '../../../src/server/audio/preprocess-text';

describe('preprocessForTts', () => {
  it('replaces a run of underscores with an ellipsis (natural TTS pause)', () => {
    expect(preprocessForTts('No ___ tu salud')).toBe('No … tu salud');
  });

  it('handles multiple blanks in the same sentence', () => {
    expect(preprocessForTts('Yo ___ y tú ____')).toBe('Yo … y tú …');
  });

  it('handles longer underscore runs', () => {
    expect(preprocessForTts('a ________ b')).toBe('a … b');
  });

  it('breaks single underscores embedded in words (e.g. snake_case)', () => {
    expect(preprocessForTts('snake_case_word')).toBe('snake case word');
  });

  it('preserves a leading underscore (no neighbour to merge with)', () => {
    // Single underscore not between word chars: leave it; TTS engine swallows it.
    expect(preprocessForTts('_foo')).toBe('_foo');
  });

  it('collapses whitespace runs and newlines', () => {
    expect(preprocessForTts('uno    dos\nthree')).toBe('uno dos three');
  });

  it('trims and returns empty for whitespace-only input', () => {
    expect(preprocessForTts('   ')).toBe('');
    expect(preprocessForTts('')).toBe('');
  });

  it('leaves an ellipsis from markdownToVoice untouched', () => {
    expect(preprocessForTts('Ich wohne in…')).toBe('Ich wohne in…');
    expect(preprocessForTts('No … tu salud.')).toBe('No … tu salud.');
  });

  it('does nothing when no underscores or extra whitespace', () => {
    expect(preprocessForTts('hello world')).toBe('hello world');
  });
});

describe('preprocessForTts: spoken punctuation', () => {
  const cases: Array<[string, string, string]> = [
    // slashes
    ['spaced slash → comma', 'sorprendido / desconcertado', 'sorprendido, desconcertado'],
    ['several spaced slashes', 'a / b / c', 'a, b, c'],
    ['glued slashes untouched', 'km/h TCP/IP I/O 1/2 and/or 12/10/2026', 'km/h TCP/IP I/O 1/2 and/or 12/10/2026'],
    ['URL untouched', 've a https://example.com/a/b ya', 've a https://example.com/a/b ya'],
    ['double slash untouched', 'a // b', 'a // b'],
    ['slash before a gap', 'a / … b', 'a … b'],
    // parentheses
    ['gloss → aside', 'desconcertado (I was … by his rude comment)', 'desconcertado, I was … by his rude comment'],
    ['aside before a period', 'Característica (feature). Otros', 'Característica, feature. Otros'],
    ['ordinals kept', '3.º asimetría (skewness). 4.º curtosis (kurtosis)', '3.º asimetría, skewness. 4.º curtosis, kurtosis'],
    ['aside mid-sentence', 'antes (código) después', 'antes, código, después'],
    ['aside before ? and !', 'a (b)? c (d)!', 'a, b? c, d!'],
    ['aside before a comma', 'a, (b), c', 'a, b, c'],
    ['aside after a sentence', 'Tisch. (der Tisch)', 'Tisch. der Tisch'],
    ['aside ending in a period', 'me. (Llámame.) Luego', 'me. Llámame. Luego'],
    ['aside after a symbol', 'x = (y)', 'x = y'],
    ['at the start', '(nota) hola', 'nota, hola'],
    ['whole text', '(nota)', 'nota'],
    ['empty parentheses dropped', 'foo () bar', 'foo bar'],
    ['inner spaces', 'a ( b ) c', 'a, b, c'],
    ['attached to a word untouched', 'f(x), parallel() y getUser(id)', 'f(x), parallel() y getUser(id)'],
    ['glued to the next word untouched', 'x (s)he y (re)encolar', 'x (s)he y (re)encolar'],
    ['nested untouched', 'a (b (c) d) e', 'a (b (c) d) e'],
    ['unclosed untouched', 'a (b c', 'a (b c'],
    ['stray closing kept, valid group converted', 'a b) c (d)', 'a b) c, d'],
    ['after ¿ untouched (no space)', '¿(a)?', '¿(a)?'],
    // arrows
    ['spaced arrows → commas', 'um + Akkusativ → der → den', 'um + Akkusativ, der, den'],
    ['ascii arrows', 'a -> b => c ⇒ d', 'a, b, c, d'],
    ['glued arrows untouched', 'a->b x=>y f→g', 'a->b x=>y f→g'],
    ['leading arrow after a sentence', 'algo. → Remember', 'algo. Remember'],
    ['arrow at the edges', '→ a →', 'a'],
    // quotes
    ['quoted term before a colon', '"Separation of concerns": separar', 'Separation of concerns: separar'],
    ['quoted terms in a question', '¿entre "remember + to" y "remember + -ing"?', '¿entre remember + to y remember + -ing?'],
    ['curly and German quotes', '“Hola” y „Hallo“', 'Hola y Hallo'],
    ['quotes in parentheses', 'x ("y")', 'x, y'],
    ['apostrophes and single quotes untouched', "don't l'eau 'x'", "don't l'eau 'x'"],
    ['inch marks untouched', '5" and 6"', '5" and 6"'],
    ['quote not wrapping a term untouched', '"a "b" c"', '"a "b" c"'],
    ['unpaired quote untouched', 'dijo "hola', 'dijo "hola'],
    // left alone
    ['symbols and numbers untouched', '¿desviación estándar ≥ MAD? a + b = c, 1,5', '¿desviación estándar ≥ MAD? a + b = c, 1,5'],
    ['abbreviations untouched', 'Ej.: x (Akk. masculino), etc., y', 'Ej.: x, Akk. masculino, etc., y'],
    ['blank with an aside', 'No ___ (x) tu salud', 'No … x, tu salud'],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(preprocessForTts(input)).toBe(expected);
    expect(preprocessForTts(expected)).toBe(expected);
  });

  it('never leaves doubled or dangling commas', () => {
    for (const [, input] of cases) expect(preprocessForTts(input)).not.toMatch(/,\s*[,.;:?!]|\s,|^,|,$/);
  });
});
