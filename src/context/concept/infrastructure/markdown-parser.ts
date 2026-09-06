import { Directionality } from '../domain/directionality';

export interface ParsedCard {
  sideA: string;
  sideB: string;
  directionality: Directionality;
  lineNumber: number;
  schedulingMetadata?: ParsedSchedulingMetadata;
}

export interface ParsedSchedulingMetadata {
  aToB: { due: string; interval: number; ease: number } | null;
  bToA: { due: string; interval: number; ease: number } | null;
}

const BIDIRECTIONAL_SEPARATOR = ':::';
/**
 * Inline unidirectional separators. Multiple variants supported because users
 * coming from the original "Spaced Repetition" Obsidian plugin may have
 * customized the separator to ">:" (a common alternative). Both work.
 * Checked in order — first match wins.
 */
const UNIDIRECTIONAL_SEPARATORS = ['::', '>:'];
/** Multiline separator that produces a bidirectional card (both directions studied). */
const MULTILINE_BIDIRECTIONAL_MARKER = '??';
/** Multiline separator that produces a unidirectional card (Q → A only). */
const MULTILINE_UNIDIRECTIONAL_MARKER = '?';
const SR_COMMENT_REGEX = /<!--SR:(.*?)-->/;
const SR_SCHEDULE_REGEX = /!(\d{4}-\d{2}-\d{2}),(\d+),(\d+)/g;

export class MarkdownParser {
  parse(content: string, _filePath: string): ParsedCard[] {
    const lines = content.split(/\r?\n/);
    const cards: ParsedCard[] = [];
    let inCodeBlock = false;
    let inFrontmatter = false;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Track YAML frontmatter (only at the very start of the file)
      if (i === 0 && trimmed === '---') {
        inFrontmatter = true;
        i++;
        continue;
      }
      if (inFrontmatter) {
        if (trimmed === '---') {
          inFrontmatter = false;
        }
        i++;
        continue;
      }

      // Toggle code block state on fenced code markers
      if (line.trimStart().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        i++;
        continue;
      }

      if (inCodeBlock) {
        i++;
        continue;
      }

      if (!trimmed) {
        i++;
        continue;
      }

      // Try inline card first (:: or :::)
      const inlineCard = this.parseInlineLine(trimmed, i + 1);
      if (inlineCard) {
        cards.push(inlineCard);
        i++;
        continue;
      }

      // Try multiline card: scan ahead for a `?` separator line
      const separatorMatch = this.findSeparatorLine(lines, i + 1);
      if (separatorMatch) {
        const result = this.parseMultilineCard(lines, i, separatorMatch.index, separatorMatch.directionality);
        if (result) {
          cards.push(result.card);
          i = result.nextIndex;
          continue;
        }
      }

      i++;
    }

    return cards;
  }

  /**
   * Parse a multiline card starting from questionStart.
   * Format:
   *   Question line(s)
   *   ?
   *   Answer line(s)  <!--SR:!date,interval,ease-->
   *
   * Answer ends at: empty line, next heading (#), or end of file.
   */
  private parseMultilineCard(
    lines: string[],
    questionStart: number,
    separatorIndex: number,
    directionality: Directionality,
  ): { card: ParsedCard; nextIndex: number } | null {
    // Collect question lines (from questionStart to separatorIndex - 1)
    const questionLines: string[] = [];
    for (let i = questionStart; i < separatorIndex; i++) {
      const line = lines[i].trim();
      if (line) questionLines.push(line);
    }

    if (questionLines.length === 0) return null;

    // Collect answer lines (from separatorIndex + 1 until empty line, heading, or EOF)
    const answerLines: string[] = [];
    let answerEnd = separatorIndex + 1;
    let schedulingMetadata: ParsedSchedulingMetadata | undefined;

    while (answerEnd < lines.length) {
      const line = lines[answerEnd];
      const trimmed = line.trim();

      // Empty line = end of card
      if (!trimmed) {
        answerEnd++;
        break;
      }

      // Next heading = end of card (don't consume it)
      if (trimmed.startsWith('#')) {
        break;
      }

      // Extract SR comment if present
      const srMatch = trimmed.match(SR_COMMENT_REGEX);
      if (srMatch) {
        schedulingMetadata = this.extractSchedulingMetadata(trimmed);
        const cleanLine = trimmed.replace(SR_COMMENT_REGEX, '').trim();
        if (cleanLine) answerLines.push(cleanLine);
        answerEnd++;
        break; // SR comment is always last
      }

      answerLines.push(trimmed);
      answerEnd++;
    }

    if (answerLines.length === 0) return null;

    const sideA = questionLines.join('\n');
    const sideB = answerLines.join('\n');

    return {
      card: {
        sideA,
        sideB,
        directionality,
        lineNumber: questionStart + 1,
        schedulingMetadata,
      },
      nextIndex: answerEnd,
    };
  }

  /**
   * Scan forward from `from` looking for a line that is exactly `?` or `??`.
   * `??` indicates a bidirectional multiline card (both directions studied).
   * Stops at empty lines, headings, or code blocks.
   */
  private findSeparatorLine(
    lines: string[],
    from: number,
  ): { index: number; directionality: Directionality } | null {
    for (let j = from; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (trimmed === MULTILINE_BIDIRECTIONAL_MARKER) {
        return { index: j, directionality: Directionality.Bidirectional };
      }
      if (trimmed === MULTILINE_UNIDIRECTIONAL_MARKER) {
        return { index: j, directionality: Directionality.Unidirectional };
      }
      if (trimmed === '') return null;
      if (trimmed.startsWith('#')) return null;
      if (trimmed.startsWith('```')) return null;
    }
    return null;
  }

  private parseInlineLine(line: string, lineNumber: number): ParsedCard | null {
    // Remove list markers (- or *)
    let content = line.replace(/^[-*]\s+/, '');

    // Extract and remove SR scheduling comment
    const schedulingMetadata = this.extractSchedulingMetadata(content);
    content = content.replace(SR_COMMENT_REGEX, '').trim();

    // Try bidirectional first (:::) then unidirectional (::)
    if (content.includes(BIDIRECTIONAL_SEPARATOR)) {
      const parts = content.split(BIDIRECTIONAL_SEPARATOR);
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        return {
          sideA: parts[0].trim(),
          sideB: parts[1].trim(),
          directionality: Directionality.Bidirectional,
          lineNumber,
          schedulingMetadata,
        };
      }
    }

    for (const sep of UNIDIRECTIONAL_SEPARATORS) {
      if (!content.includes(sep)) continue;
      const separatorIndex = content.indexOf(sep);
      const sideA = content.substring(0, separatorIndex).trim();
      const sideB = content.substring(separatorIndex + sep.length).trim();

      if (sideA && sideB) {
        return {
          sideA,
          sideB,
          directionality: Directionality.Unidirectional,
          lineNumber,
          schedulingMetadata,
        };
      }
    }

    return null;
  }

  private extractSchedulingMetadata(content: string): ParsedSchedulingMetadata | undefined {
    const match = content.match(SR_COMMENT_REGEX);
    if (!match) return undefined;

    const schedules: { due: string; interval: number; ease: number }[] = [];
    let schedMatch;
    const regex = new RegExp(SR_SCHEDULE_REGEX.source, 'g');

    while ((schedMatch = regex.exec(match[1])) !== null) {
      schedules.push({
        due: schedMatch[1],
        interval: parseInt(schedMatch[2]),
        ease: parseInt(schedMatch[3]),
      });
    }

    return {
      aToB: schedules[0] ?? null,
      bToA: schedules[1] ?? null,
    };
  }
}
