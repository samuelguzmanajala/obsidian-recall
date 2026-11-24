import { AuthorizationServer as SharedAuthorizationServer, OAuthStore, type ApprovalTexts, type AuthorizationServerOptions as SharedOptions } from '@samuelguzman/mcp-oauth';

// The authorization server lives in the shared package (@samuelguzman/mcp-oauth), also used by the
// mcp-hub gateway. This module only fixes what is Recall's own: its scope, its name and the wording
// of the approval page.
export {
  ACCESS_TOKEN_TTL_MS, CODE_TTL_MS, FAILED_APPROVAL_DELAY_MS, MAX_UNAPPROVED_CLIENTS, REFRESH_TOKEN_TTL_MS, secretEquals,
  type OAuthResponse,
} from '@samuelguzman/mcp-oauth';

export const SCOPE = 'recall';
export const RECALL_APPROVAL_TEXTS: ApprovalTexts = {
  productName: 'Recall',
  accessDescription: 'your Recall decks and study data',
  ownerTokenLabel: 'Recall token (RECALL_TOKEN)',
};

export type AuthorizationServerOptions = Omit<SharedOptions, 'scope' | 'resourceName' | 'texts'>;

/** Recall's authorization server: the shared one with Recall's scope, name and texts. */
export class AuthorizationServer extends SharedAuthorizationServer {
  constructor(store: OAuthStore, options: AuthorizationServerOptions) {
    super(store, { ...options, scope: SCOPE, resourceName: 'Recall', texts: RECALL_APPROVAL_TEXTS });
  }
}
