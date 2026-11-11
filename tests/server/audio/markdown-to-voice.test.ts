import { describe, it, expect } from 'vitest';
import { markdownToVoice } from '../../../src/server/audio/markdown-to-voice';

describe('markdownToVoice', () => {
  it('strips bold and italic markers', () => {
    expect(markdownToVoice('**hola** _mundo_')).toBe('hola mundo');
    expect(markdownToVoice('__fuerte__ *cursiva*')).toBe('fuerte cursiva');
  });

  it('keeps inline code content but drops backticks', () => {
    expect(markdownToVoice('usa `npm install` para instalar')).toBe('usa npm install para instalar');
  });

  it('replaces fenced code blocks with the placeholder "(código)"', () => {
    const md = 'antes\n```ts\nconst x = 1;\n```\ndespués';
    expect(markdownToVoice(md)).toContain('(código)');
    expect(markdownToVoice(md)).not.toContain('const x');
  });

  it('unwraps wikilinks with and without alias', () => {
    expect(markdownToVoice('ver [[concepto]]')).toBe('ver concepto');
    expect(markdownToVoice('ver [[target|texto bonito]]')).toBe('ver texto bonito');
  });

  it('unwraps markdown links to their text', () => {
    expect(markdownToVoice('lee [el artículo](https://example.com)')).toBe('lee el artículo');
  });

  it('drops headers but keeps the header text', () => {
    expect(markdownToVoice('# Título\nsubtexto')).toBe('Título. subtexto');
    expect(markdownToVoice('### Tres')).toBe('Tres');
  });

  it('drops list bullets', () => {
    expect(markdownToVoice('- uno\n- dos\n- tres')).toBe('uno. dos. tres');
    expect(markdownToVoice('1. primero\n2. segundo')).toBe('primero. segundo');
  });

  it('strips HTML tags', () => {
    expect(markdownToVoice('hola <b>mundo</b> <br/> ¿qué tal?')).toBe('hola mundo ¿qué tal?');
  });

  it('drops blockquote markers', () => {
    expect(markdownToVoice('> cita importante')).toBe('cita importante');
  });

  it('joins multi-line content with periods for natural TTS phrasing', () => {
    expect(markdownToVoice('línea uno\n\nlínea dos')).toBe('línea uno. línea dos');
  });

  it('returns trimmed plain text from a complex card', () => {
    const md = '## Pregunta\n¿Qué es **DDD**?\n\n- _Domain_-Driven Design\n- Ver [[ddd-intro]]';
    const out = markdownToVoice(md);
    expect(out).toBe('Pregunta. ¿Qué es DDD?. Domain-Driven Design. Ver ddd-intro');
  });

  it('handles empty input', () => {
    expect(markdownToVoice('')).toBe('');
    expect(markdownToVoice('   \n  \n  ')).toBe('');
  });

  it('does not break on isolated underscores or asterisks', () => {
    expect(markdownToVoice('snake_case y a*b')).toBe('snake_case y a*b');
  });
});
