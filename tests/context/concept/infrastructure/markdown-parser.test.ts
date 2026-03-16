import { describe, it, expect } from 'vitest';
import { MarkdownParser } from '@context/concept/infrastructure/markdown-parser';
import { Directionality } from '@context/concept/domain/directionality';

describe('MarkdownParser', () => {
  const parser = new MarkdownParser();

  describe('bidirectional cards (:::)', () => {
    it('should parse a simple bidirectional card', () => {
      const content = '- Aber:::Pero';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('Aber');
      expect(cards[0].sideB).toBe('Pero');
      expect(cards[0].directionality).toBe(Directionality.Bidirectional);
      expect(cards[0].lineNumber).toBe(1);
    });

    it('should parse bidirectional card with SR scheduling comment', () => {
      const content = '- Aber:::Pero <!--SR:!2026-03-26,31,287!2026-04-06,26,266-->';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('Aber');
      expect(cards[0].sideB).toBe('Pero');
      expect(cards[0].schedulingMetadata).toBeDefined();
      expect(cards[0].schedulingMetadata!.aToB).toEqual({
        due: '2026-03-26',
        interval: 31,
        ease: 287,
      });
      expect(cards[0].schedulingMetadata!.bToA).toEqual({
        due: '2026-04-06',
        interval: 26,
        ease: 266,
      });
    });

    it('should parse card with parenthetical content', () => {
      const content = '- Abteilung (die, pl. Abteilungen):::departamento';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('Abteilung (die, pl. Abteilungen)');
      expect(cards[0].sideB).toBe('departamento');
    });
  });

  describe('unidirectional cards (::)', () => {
    it('should parse a simple unidirectional card', () => {
      const content = '- What is DDD?::Domain-Driven Design';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('What is DDD?');
      expect(cards[0].sideB).toBe('Domain-Driven Design');
      expect(cards[0].directionality).toBe(Directionality.Unidirectional);
    });
  });

  describe('multiple cards', () => {
    it('should parse multiple cards from content', () => {
      const content = [
        '# Vocabulario',
        '',
        '- Aber:::Pero',
        '- Arbeiten:::Trabajar',
        '- What is DDD?::Domain-Driven Design',
        '',
        'Some other text',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(3);
      expect(cards[0].directionality).toBe(Directionality.Bidirectional);
      expect(cards[1].directionality).toBe(Directionality.Bidirectional);
      expect(cards[2].directionality).toBe(Directionality.Unidirectional);
    });

    it('should track correct line numbers', () => {
      const content = [
        '# Title',
        '',
        '- Card1:::Side1',
        '',
        '- Card2:::Side2',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards[0].lineNumber).toBe(3);
      expect(cards[1].lineNumber).toBe(5);
    });
  });

  describe('edge cases', () => {
    it('should ignore lines without separators', () => {
      const content = 'Just a normal line of text';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(0);
    });

    it('should ignore empty sides', () => {
      const content = '- :::';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(0);
    });

    it('should handle * list markers', () => {
      const content = '* Aber:::Pero';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('Aber');
    });

    it('should handle cards without list markers', () => {
      const content = 'Aber:::Pero';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
    });

    it('should parse card with only one scheduling entry', () => {
      const content = '- Question::Answer <!--SR:!2026-03-26,31,287-->';
      const cards = parser.parse(content, 'test.md');

      expect(cards[0].schedulingMetadata!.aToB).toBeDefined();
      expect(cards[0].schedulingMetadata!.bToA).toBeNull();
    });
  });
});
