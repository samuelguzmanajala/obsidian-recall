import { describe, it, expect } from 'vitest';
import { markdownToVoice } from '../../../src/server/audio/markdown-to-voice';
import { audioSource } from '../../../src/server/audio/audio-plan';

// 24 real card sides (German, English, dev, data science). Input: markdownToVoice output as
// sampled; expected: what the deterministic rules make of it (no LLM rewrite).
const corpus: Array<[string, string]> = [
  ['Pflegefachfrau', 'Pflegefachfrau'],
  ['enfermera profesional (usado en Suiza)', 'enfermera profesional, usado en Suiza'],
  ['Ich wohne in..', 'Ich wohne in…'],
  ['Vivo en..', 'Vivo en…'],
  ['Wir sitzen um … Tisch. (der Tisch → Akk. masculino)', 'Wir sitzen um … Tisch. der Tisch, Akk. masculino'],
  ['Wir sitzen um den Tisch. um + Akkusativ → der → den', 'Wir sitzen um den Tisch. um + Akkusativ, der, den'],
  ['taken aback', 'taken aback'],
  ['sorprendido / desconcertado (I was … by his rude comment)', 'sorprendido, desconcertado, I was … by his rude comment'],
  ['carry out', 'carry out'],
  [
    'llevar a cabo / realizar / ejecutar (una tarea, un plan o una investigación). Ej.: They carried out the plan = Llevaron a cabo el plan. Separable: carry out the plan / carry the plan out / carry it out. Formas: carry → carried → carried. Contraste: Achieve vs Carry out vs Devote.',
    'llevar a cabo, realizar, ejecutar, una tarea, un plan o una investigación. Ej.: They carried out the plan = Llevaron a cabo el plan. Separable: carry out the plan, carry the plan out, carry it out. Formas: carry, carried, carried. Contraste: Achieve vs Carry out vs Devote.',
  ],
  ['¿Cuál es la diferencia entre "remember + to" y "remember + -ing"?', '¿Cuál es la diferencia entre remember + to y remember + -ing?'],
  [
    'Remember + to: acordarse de hacer algo (futuro). → Remember to call me. (Acuérdate de llamarme). Remember + -ing: recordar haber hecho algo (pasado). → I remember calling you. (Recuerdo haberte llamado)',
    'Remember + to: acordarse de hacer algo, futuro. Remember to call me. Acuérdate de llamarme. Remember + -ing: recordar haber hecho algo, pasado. I remember calling you. Recuerdo haberte llamado',
  ],
  ['¿Cuál es la interpretación moderna de SRP según Dijkstra?', '¿Cuál es la interpretación moderna de SRP según Dijkstra?'],
  [
    '"Separation of concerns": separar aspectos que nos preocupan al desarrollar funcionalidad, siendo evolutiva y contextual según las necesidades reales.',
    'Separation of concerns: separar aspectos que nos preocupan al desarrollar funcionalidad, siendo evolutiva y contextual según las necesidades reales.',
  ],
  ['¿Qué responsabilidad tiene la aplicación en la solución de re-encolar eventos?', '¿Qué responsabilidad tiene la aplicación en la solución de re-encolar eventos?'],
  ['Debe gestionar los reintentos, definir un límite máximo y enviar eventos fallidos a una dead letter queue.', 'Debe gestionar los reintentos, definir un límite máximo y enviar eventos fallidos a una dead letter queue.'],
  ['¿Qué otro Bean se autoconfigura al redefinir UserDetailsService?', '¿Qué otro Bean se autoconfigura al redefinir UserDetailsService?'],
  ['PasswordEncoder', 'PasswordEncoder'],
  ['En ciencia de datos, ¿cómo se denomina una columna de una tabla?', 'En ciencia de datos, ¿cómo se denomina una columna de una tabla?'],
  [
    'Característica (feature). Otros nombres según disciplina: variable predictora, atributo, entrada',
    'Característica, feature. Otros nombres según disciplina: variable predictora, atributo, entrada',
  ],
  ['¿Cuáles son los cuatro primeros momentos de una distribución?', '¿Cuáles son los cuatro primeros momentos de una distribución?'],
  ['1.º localización. 2.º variabilidad. 3.º asimetría (skewness). 4.º curtosis (kurtosis)', '1.º localización. 2.º variabilidad. 3.º asimetría, skewness. 4.º curtosis, kurtosis'],
  ['¿Se cumple siempre desviación estándar ≥ desviación media absoluta ≥ MAD?', '¿Se cumple siempre desviación estándar ≥ desviación media absoluta ≥ MAD?'],
  [
    'No: la primera desigualdad sí se cumple para las definiciones y condiciones indicadas en la nota. No existe un orden universal entre la desviación media absoluta y la MAD sin escalar',
    'No: la primera desigualdad sí se cumple para las definiciones y condiciones indicadas en la nota. No existe un orden universal entre la desviación media absoluta y la MAD sin escalar',
  ],
];

describe('spoken text of real card sides', () => {
  it.each(corpus)('%s', (sampled, expected) => {
    const out = audioSource(markdownToVoice(sampled));
    expect(out).toBe(expected);
    expect(audioSource(markdownToVoice(out))).toBe(out);
  });
});
