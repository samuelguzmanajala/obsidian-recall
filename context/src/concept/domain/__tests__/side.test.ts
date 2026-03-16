import { describe, it, expect } from 'vitest';
import { Side } from '../side';

describe('Side', () => {
  it('should create a side with markdown content', () => {
    const side = new Side('What is **DDD**?');
    expect(side.content).toBe('What is **DDD**?');
  });

  it('should reject empty content', () => {
    expect(() => new Side('')).toThrow('Side content cannot be empty');
  });

  it('should reject whitespace-only content', () => {
    expect(() => new Side('   ')).toThrow('Side content cannot be empty');
  });

  it('should be equal when content matches', () => {
    const a = new Side('hello');
    const b = new Side('hello');
    expect(a.equals(b)).toBe(true);
  });

  it('should not be equal when content differs', () => {
    const a = new Side('hello');
    const b = new Side('world');
    expect(a.equals(b)).toBe(false);
  });
});
