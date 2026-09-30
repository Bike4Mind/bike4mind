/**
 * Human-readable labels for the OAuth scopes shown on the consent screen.
 *
 * The scope list on that screen comes from the server (`/api/oauth/code` returns the client's
 * requested scopes, already validated against what the client is registered for), so this map
 * can never be exhaustive: registering a client with a new scope must not require a client
 * release. An unmapped scope is therefore rendered as its raw id with no description - NEVER
 * hidden. Dropping a scope we cannot name would understate what the user is about to grant,
 * which is the one failure mode a consent screen must not have.
 */
export interface ConsentScope {
  /** The raw scope id, always shown so the grant stays auditable. */
  id: string;
  /** Plain-language description, or null when this scope has no mapping yet. */
  label: string | null;
}

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  openid: 'Confirm who you are',
  profile: 'See your name and profile details',
  email: 'See your email address',
  'ai:chat': 'Use your Bike4Mind credits to generate AI responses',
  'ai:generate': 'Use your Bike4Mind credits to generate images, video and audio',
  'notebooks:read': 'View your notebooks and sessions',
  'notebooks:write': 'Create and modify your notebooks',
  'files:read': 'View your uploaded files',
  'files:write': 'Upload and modify your files',
};

/**
 * Maps requested scope ids to display rows, preserving the order the server sent them.
 * `openid` and `profile` are both mapped rather than merged: they are separate grants, and
 * collapsing them would show the user fewer permissions than the client actually receives.
 */
export function toConsentScopes(scopes: readonly string[]): ConsentScope[] {
  return scopes.map(id => ({ id, label: SCOPE_LABELS[id] ?? null }));
}
