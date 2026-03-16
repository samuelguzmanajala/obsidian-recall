import { Identifier } from '@context/shared/domain/identifier';

export class StudyItemId extends Identifier {
  constructor(value: string) {
    super(value);
  }
}
