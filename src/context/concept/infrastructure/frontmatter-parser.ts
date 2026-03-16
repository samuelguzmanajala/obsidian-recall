const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;
const TAG_LINE_REGEX = /^\s+-\s+(?:"#?|#?)([^"]+)"?\s*$/;

/**
 * Extracts tags from YAML frontmatter.
 * Supports formats:
 *   - German
 *   - "#German/vocabulary1"
 *   - #German/grammar
 */
export class FrontmatterParser {
  extractTags(content: string): string[] {
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) return [];

    const yaml = match[1];
    const lines = yaml.split('\n');
    const tags: string[] = [];
    let inTags = false;

    for (const line of lines) {
      if (line.match(/^tags:\s*$/)) {
        inTags = true;
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
}
