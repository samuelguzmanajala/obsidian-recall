/**
 * Port for asynchronous (batch) speech synthesis. A job is created once (creation is NOT
 * idempotent), polled by name, and its results are matched to requests by `key`.
 */
export interface TtsBatchRequest { key: string; text: string }
export interface TtsBatchConfig { model: string; voice: string; instructions?: string }

export type TtsBatchResult =
  | { key: string; wav: Buffer; promptTokens: number; outputTokens: number }
  | { key: string; error: string };

export interface TtsBatchJob {
  name: string;
  displayName?: string;
  /** Provider state, e.g. BATCH_STATE_RUNNING. */
  state: string;
  /** Terminal: no further change (succeeded, failed, cancelled or expired). */
  done: boolean;
  succeeded: boolean;
  /** Present once a successful job is done. */
  results?: TtsBatchResult[];
  error?: string;
}

/**
 * The provider answered the create call with an error, so no job exists.
 * `quota`: rejected for rate/enqueued-token limits; a smaller batch may be accepted.
 * Any other failure of `create` (network, timeout, 5xx) is ambiguous: the job may exist.
 */
export class TtsBatchRejectedError extends Error {
  constructor(message: string, readonly quota: boolean) { super(message); this.name = 'TtsBatchRejectedError'; }
}

export interface TtsBatchClient {
  create(displayName: string, requests: TtsBatchRequest[], config: TtsBatchConfig): Promise<{ name: string }>;
  get(name: string): Promise<TtsBatchJob>;
  /** Names of recent jobs with this display name (crash recovery). */
  findByDisplayName(displayName: string): Promise<string[]>;
}
