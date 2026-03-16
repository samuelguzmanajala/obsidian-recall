import { Identifier } from '@context/shared/domain/identifier';

export class SessionId extends Identifier {
  constructor(value: string) {
    super(value);
  }
}
