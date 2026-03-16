import { Identifier } from '@context/shared/domain/identifier';

export class DeckId extends Identifier {
  constructor(value: string) {
    super(value);
  }
}
