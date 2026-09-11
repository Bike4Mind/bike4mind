import { ApiKeyScope } from '@bike4mind/common';

/**
 * Per-action scope gate for the WebSocket handlers that authorize on the Connection row alone.
 *
 * `$connect` (connect.ts) admits an API key holding ANY ONE of `ai:generate` / `ai:chat` /
 * `cc-bridge:connect` and persists that key's whole scope list on the Connection row. Nothing
 * downstream read it back, so a socket opened with a bridge-only key could then send any frame
 * the transport accepts. Each Connection-only handler names the scope its own action needs and
 * calls this before acting - the comment at connect.ts anticipated exactly this check.
 *
 * An empty or absent scope list passes. That is not a hole: it means no delegated credential is
 * recorded on the row, which is a JWT socket - a full user session, not a narrowed key - and
 * `resolveIdentity` will not admit an API key holding none of the three connect scopes, so a
 * scopeless key cannot reach a handler in the first place. Absent and empty are treated alike
 * because Mongoose materialises an unset array path as `[]`.
 *
 * OR semantics over `required`, matching `decideScopeGate` (apiKeyScopeGate.ts) so the two gates
 * cannot come to read differently. There is deliberately no staging escape hatch, for the reason
 * that file gives for `verifyApiKey`: every sender of these actions today is a browser or the CLI
 * on a JWT socket, so there is no grandfathered API-key population a grace period could rescue.
 */
export function connectionHoldsScope(
  connection: { scopes?: string[] | null } | null | undefined,
  required: ApiKeyScope[]
): boolean {
  const held = connection?.scopes;
  if (!held?.length) return true;
  return required.some(scope => held.includes(scope));
}
