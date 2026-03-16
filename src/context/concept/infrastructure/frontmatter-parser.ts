const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
const TAG_LINE_REGEX = /^\s+-\s+(?:"#?|#?)([^"]+)"?\s*$/;
const INLINE_TAGS_REGEX = /^tags:\s*\[([^\]]*)\]\s*$/;
const SINGLE_TAG_REGEX = /^tags:\s+(.+)\s*$/;

/**
 * Extracts tags from YAML frontmatter.
 * Supports formats:
 *   List style:
 *     tags:
 *       - German
 *       - "#German/vocabulary1"
 *       - #German/grammar
 *   Inline array:
 *     tags: [German, German/vocabulary]
 *     tags: ["#German", #German/grammar]
 *   Single value:
 *     tags: German
 *     tags: "#German/vocabulary"
 */
export class FrontmatterParser {
  extractTags(content: string): string[] {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) return [];

    const yaml = match[1];
    const lines = yaml.split(/\r?\n/);
    const tags: string[] = [];
    let inTags = false;

    for (const line of lines) {
      // Inline array: tags: [German, English]
      const inlineMatch = line.match(INLINE_TAGS_REGEX);
      if (inlineMatch) {
        const inlineTags = inlineMatch[1]
          .split(',')
          .map(t => t.trim())
          .filter(t => t.length > 0)
          .map(t => this.cleanTag(t));
        tags.push(...inlineTags);
        continue;
      }

      // List format header: tags:  (nothing after colon)
      if (line.match(/^tags:\s*$/)) {
        inTags = true;
        continue;
      }

      // Single value: tags: German
      // Must check AFTER inline array (which also starts with "tags:")
      const singleMatch = line.match(SINGLE_TAG_REGEX);
      if (singleMatch && !singleMatch[1].startsWith('[')) {
        // Could be comma-separated without brackets: tags: German, English
        const values = singleMatch[1].split(',').map(t => this.cleanTag(t.trim())).filter(t => t.length > 0);
        tags.push(...values);
        continue;
      }

      if (inTags) {
        const tagMatch = line.match(TAG_LINE_REGEX);
        if (tagMatch) {
          tags.push(tagMatch[1].trim());
        } else if (!line.match(/^\s+-/)) {
          // No longer in tags list
          inTags = false;
        }
      }
    }

    return tags;
  }

  /**
   * Removes quotes and # prefix from a tag value.
   * "German" → German, "#German/vocab" → German/vocab, #German → German
   */
  private cleanTag(raw: string): string {
    let cleaned = raw;
    // Remove surrounding quotes
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1);
    }
    // Remove leading #
    if (cleaned.startsWith('#')) {
      cleaned = cleaned.slice(1);
    }
    return cleaned.trim();
  }
}
