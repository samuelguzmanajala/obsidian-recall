import { Identifier } from '@context/shared/domain/identifier';

export class ConceptId extends Identifier {
  constructor(value: string) {
    super(value);
  }
}
