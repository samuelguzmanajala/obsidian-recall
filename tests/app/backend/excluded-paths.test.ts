import { describe, expect, it } from 'vitest';
import { isExcludedPath } from '../../../src/app/backend/excluded-paths';

describe('isExcludedPath', () => {
  it('excludes any path with a node_modules folder segment', () => {
    expect(isExcludedPath('node_modules/x.md')).toBe(true);
    expect(isExcludedPath('a/node_modules/b.md')).toBe(true);
    expect(isExcludedPath('node_modules/fsevents/README.md')).toBe(true);
    expect(isExcludedPath('proj/web/node_modules/pkg/docs/deep/Note.md')).toBe(true);
  });
  it('keeps ordinary notes, including names that merely contain the word', () => {
    expect(isExcludedPath('my node_modules notes.md')).toBe(false);
    expect(isExcludedPath('dev/node_modules.md')).toBe(false);
    expect(isExcludedPath('a/node_modules_old/b.md')).toBe(false);
    expect(isExcludedPath('a/b/c.md')).toBe(false);
  });
});
