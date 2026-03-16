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

    it('should ignore cards inside fenced code blocks', () => {
      const content = [
        '- Real:::Card',
        '```',
        '- Fake:::Card',
        'Also:::Fake',
        '```',
        '- Another:::Real',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(2);
      expect(cards[0].sideA).toBe('Real');
      expect(cards[1].sideA).toBe('Another');
    });

    it('should handle code blocks with language specifier', () => {
      const content = [
        '```typescript',
        'const sep = ":::";',
        '```',
        '- Valid:::Card',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('Valid');
    });

    it('should skip YAML frontmatter', () => {
      const content = [
        '---',
        'description: "Use :: for definitions"',
        'tags:',
        '  - German',
        '---',
        '- Real:::Card',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('Real');
    });

    it('should handle frontmatter with \\r\\n line endings', () => {
      const content = '---\r\ntitle: Test\r\n---\r\n- Word:::Translation';

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('Word');
    });

    it('should not treat --- in middle of file as frontmatter', () => {
      const content = [
        '- Card1:::Side1',
        '---',
        'description::value',
        '---',
        '- Card2:::Side2',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      // Card1, description::value (unidirectional), Card2
      expect(cards).toHaveLength(3);
    });
  });

  describe('multiline cards (?)', () => {
    it('should parse a simple multiline card', () => {
      const content = [
        '¿Con qué pregunta identificas el NOMINATIV?',
        '?',
        '**¿Quién?** (Wer?) — el que hace la acción.',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('¿Con qué pregunta identificas el NOMINATIV?');
      expect(cards[0].sideB).toBe('**¿Quién?** (Wer?) — el que hace la acción.');
      expect(cards[0].directionality).toBe(Directionality.Unidirectional);
    });

    it('should parse multiline answer with multiple lines', () => {
      const content = [
        '¿Qué artículo cambia de Nominativ a Akkusativ?',
        '?',
        'Solo el **masculino**: **der → den**',
        '(die y das NO cambian)',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideB).toBe('Solo el **masculino**: **der → den**\n(die y das NO cambian)');
    });

    it('should parse multiline card with SR comment', () => {
      const content = [
        '¿Con qué pregunta identificas el DATIV?',
        '?',
        '**¿A quién?** (Wem?) — a quién le das/dices algo.',
        'Ich gebe dem Mann das Buch. → ¿A quién le doy? → Dem Mann <!--SR:!2026-04-16,36,241-->',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('¿Con qué pregunta identificas el DATIV?');
      expect(cards[0].sideB).toContain('**¿A quién?**');
      expect(cards[0].sideB).toContain('Dem Mann');
      expect(cards[0].sideB).not.toContain('<!--SR:');
      expect(cards[0].schedulingMetadata).toBeDefined();
      expect(cards[0].schedulingMetadata!.aToB!.due).toBe('2026-04-16');
    });

    it('should parse consecutive multiline cards separated by empty lines', () => {
      const content = [
        '¿Pregunta 1?',
        '?',
        'Respuesta 1',
        '',
        '¿Pregunta 2?',
        '?',
        'Respuesta 2',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(2);
      expect(cards[0].sideA).toBe('¿Pregunta 1?');
      expect(cards[0].sideB).toBe('Respuesta 1');
      expect(cards[1].sideA).toBe('¿Pregunta 2?');
      expect(cards[1].sideB).toBe('Respuesta 2');
    });

    it('should stop answer at heading', () => {
      const content = [
        'Question',
        '?',
        'Answer line 1',
        'Answer line 2',
        '# Next Section',
        'Not an answer',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideB).toBe('Answer line 1\nAnswer line 2');
    });

    it('should parse fill-in-the-blank multiline cards', () => {
      const content = [
        'Ich fahre **mit** `___` Auto. (das Auto → Dativ neutro)',
        '?',
        'Ich fahre **mit dem** Auto.',
        '*mit + Dativ → das → dem* <!--SR:!2026-03-14,2,215-->',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toContain('`___`');
      expect(cards[0].sideB).toContain('**mit dem**');
    });

    it('should mix inline and multiline cards', () => {
      const content = [
        '- Hund:::Dog',
        '',
        '¿Qué es DDD?',
        '?',
        'Domain-Driven Design',
        '',
        '- Cat::Gato',
      ].join('\n');

      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(3);
      expect(cards[0].directionality).toBe(Directionality.Bidirectional);
      expect(cards[1].directionality).toBe(Directionality.Unidirectional);
      expect(cards[1].sideA).toBe('¿Qué es DDD?');
      expect(cards[2].directionality).toBe(Directionality.Unidirectional);
    });

    it('should not treat ? inside a sentence as separator', () => {
      const content = '- What is DDD?::Domain-Driven Design';
      const cards = parser.parse(content, 'test.md');

      expect(cards).toHaveLength(1);
      expect(cards[0].sideA).toBe('What is DDD?');
    });
  });
});
