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
const UNIDIRECTIONAL_SEPARATOR = '::';
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

      // Try multiline card: look ahead for a `?` separator line
      const nextNonEmpty = this.findNextNonEmpty(lines, i + 1);
      if (nextNonEmpty !== -1 && lines[nextNonEmpty].trim() === '?') {
        const result = this.parseMultilineCard(lines, i, nextNonEmpty);
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

      // Next `?` separator with content before it = start of next card (don't consume)
      // But only if the previous line was non-empty (to avoid false positives)
      if (answerEnd > separatorIndex + 1) {
        const lookAhead = this.findNextNonEmpty(lines, answerEnd + 1);
        if (trimmed === '?' || (lookAhead !== -1 && lines[lookAhead].trim() === '?')) {
          // Check if this line is actually a question for the next card
          if (lookAhead !== -1 && lines[lookAhead].trim() === '?' && trimmed !== '?') {
            break;
          }
        }
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
        directionality: Directionality.Unidirectional,
        lineNumber: questionStart + 1,
        schedulingMetadata,
      },
      nextIndex: answerEnd,
    };
  }

  private findNextNonEmpty(lines: string[], from: number): number {
    // For multiline, the ? must be immediately the next line (no gaps)
    if (from < lines.length) {
      return from;
    }
    return -1;
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

    if (content.includes(UNIDIRECTIONAL_SEPARATOR)) {
      const separatorIndex = content.indexOf(UNIDIRECTIONAL_SEPARATOR);
      const sideA = content.substring(0, separatorIndex).trim();
      const sideB = content.substring(separatorIndex + UNIDIRECTIONAL_SEPARATOR.length).trim();

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
