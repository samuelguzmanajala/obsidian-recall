import { Session } from './session';
import { SessionId } from './session-id';
import { DeckId } from '@context/deck/domain/deck-id';

export interface SessionRepository {
  save(session: Session): Promise<void>;
  findById(id: SessionId): Promise<Session | null>;
  findByDeckId(deckId: DeckId): Promise<Session[]>;
  findActive(): Promise<Session | null>;
}
