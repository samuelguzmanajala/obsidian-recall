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
  parse(content: string, filePath: string): ParsedCard[] {
    const lines = content.split('\n');
    const cards: ParsedCard[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const card = this.parseLine(line, i + 1);
      if (card) {
        cards.push(card);
      }
    }

    return cards;
  }

  private parseLine(line: string, lineNumber: number): ParsedCard | null {
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
