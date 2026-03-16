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

  describe('inline format', () => {
    it('should extract tags from inline array', () => {
      const content = `---
tags: [German, English]
---
# Content`;

      expect(parser.extractTags(content)).toEqual(['German', 'English']);
    });

    it('should handle inline tags with # prefix', () => {
      const content = `---
tags: [#German, "#English/grammar"]
---
# Content`;

      expect(parser.extractTags(content)).toEqual(['German', 'English/grammar']);
    });

    it('should handle inline tags with hierarchical paths', () => {
      const content = `---
tags: [German/vocabulary, German/grammar]
---
# Content`;

      expect(parser.extractTags(content)).toEqual(['German/vocabulary', 'German/grammar']);
    });

    it('should handle empty inline array', () => {
      const content = `---
tags: []
---
# Content`;

      expect(parser.extractTags(content)).toEqual([]);
    });
  });

  describe('single value format', () => {
    it('should extract single tag value', () => {
      const content = `---
tags: German
---
# Content`;

      expect(parser.extractTags(content)).toEqual(['German']);
    });

    it('should handle single tag with # prefix', () => {
      const content = `---
tags: #German/vocabulary
---
# Content`;

      expect(parser.extractTags(content)).toEqual(['German/vocabulary']);
    });

    it('should handle comma-separated without brackets', () => {
      const content = `---
tags: German, English
---
# Content`;

      expect(parser.extractTags(content)).toEqual(['German', 'English']);
    });
  });

  describe('windows line endings', () => {
    it('should parse frontmatter with \\r\\n', () => {
      const content = '---\r\ntags:\r\n  - German\r\n  - German/grammar\r\n---\r\n# Content';

      expect(parser.extractTags(content)).toEqual(['German', 'German/grammar']);
    });

    it('should parse inline tags with \\r\\n', () => {
      const content = '---\r\ntags: [German, English]\r\n---\r\n# Content';

      expect(parser.extractTags(content)).toEqual(['German', 'English']);
    });
  });
});
