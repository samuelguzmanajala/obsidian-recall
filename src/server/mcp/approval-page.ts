import type { OAuthClient } from './oauth-store';

/** Authorization request parameters echoed back by the approval form (never the owner token). */
const FORWARDED = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];

const escape = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#161616}input{background:#222;color:inherit}}
h1{font-size:1.4rem}code{word-break:break-all}label,input,button{display:block;width:100%;box-sizing:border-box}
input{margin:.4rem 0 1rem;padding:.6rem;font:inherit;border:1px solid #888;border-radius:6px}
.row{display:flex;gap:.6rem}button{padding:.6rem;font:inherit;border-radius:6px;border:1px solid #888;cursor:pointer}
button[value=approve]{background:#2457c5;color:#fff;border-color:#2457c5}.error{color:#c62828;font-weight:600}
</style></head><body>${body}</body></html>`;
}

export function errorPage(message: string): string {
  return page('Recall authorization', `<h1>Recall authorization</h1><p class="error">${escape(message)}</p>`);
}

/** The owner proves they own this Recall backend by typing `RECALL_TOKEN`. */
export function approvalPage(client: OAuthClient, redirectUri: string, params: URLSearchParams, error?: string): string {
  const name = typeof client.metadata.client_name === 'string' ? client.metadata.client_name : 'An unnamed client';
  const hidden = FORWARDED.filter(k => params.has(k))
    .map(k => `<input type="hidden" name="${k}" value="${escape(params.get(k)!)}">`).join('');
  return page('Authorize access to Recall', `<h1>Authorize access to Recall</h1>
<p><strong>${escape(name)}</strong> wants full access to your Recall decks and study data through the MCP connector.</p>
<p>After approval you will be sent to <code>${escape(new URL(redirectUri).origin)}</code>.</p>
${error ? `<p class="error">${escape(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">${hidden}
<label for="owner_token">Recall token (RECALL_TOKEN)</label>
<input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus>
<div class="row"><button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button></div></form>`);
}
