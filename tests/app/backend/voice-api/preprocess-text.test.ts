import { describe, it, expect } from 'vitest';
import { preprocessForTts } from '@app/backend/voice-api/preprocess-text';

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

  it('does nothing when no underscores or extra whitespace', () => {
    expect(preprocessForTts('hello world')).toBe('hello world');
  });
});
