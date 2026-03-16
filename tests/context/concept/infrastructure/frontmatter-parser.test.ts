import { describe, it, expect } from 'vitest';
import { FrontmatterParser } from '@context/concept/infrastructure/frontmatter-parser';

describe('FrontmatterParser', () => {
  const parser = new FrontmatterParser();

  it('should extract simple tags', () => {
    const content = `---
tags:
  - German
  - German/grammar
---
# Content`;

    expect(parser.extractTags(content)).toEqual(['German', 'German/grammar']);
  });

  it('should extract quoted tags with #', () => {
    const content = `---
tags:
  - "#German/vocabulary1"
---
# Content`;

    expect(parser.extractTags(content)).toEqual(['German/vocabulary1']);
  });

  it('should extract tags with # prefix without quotes', () => {
    const content = `---
tags:
  - #German
---
# Content`;

    expect(parser.extractTags(content)).toEqual(['German']);
  });

  it('should return empty array if no frontmatter', () => {
    const content = '# Just a heading\nSome content';
    expect(parser.extractTags(content)).toEqual([]);
  });

  it('should return empty array if no tags', () => {
    const content = `---
date: 2025-10-22
---
# Content`;

    expect(parser.extractTags(content)).toEqual([]);
  });

  it('should handle mixed tag formats', () => {
    const content = `---
date: 2025-10-25
tags:
  - German
  - "#German/grammar"
  - #German/vocabulary
related:
  - something
---
# Content`;

    expect(parser.extractTags(content)).toEqual([
      'German',
      'German/grammar',
      'German/vocabulary',
    ]);
  });
});
