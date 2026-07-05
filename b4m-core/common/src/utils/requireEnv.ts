/**
 * Open-core config helper: read a required value from the environment with NO
 * brand/account fallback.
 *
 * The point is that an unset value must fail loud rather than silently defaulting
 * to a Bike4Mind domain, Stripe price ID, GA property, AWS account, or support
 * email. A fork deploying its own instance should never inherit Bike4Mind
 * infrastructure by omission.
 *
 * Bundling note / convention: in client/browser code `process.env.X` is only
 * statically inlined when referenced by literal name, so client callers MUST pass
 * the value explicitly: `requireEnv('NEXT_PUBLIC_FOO', process.env.NEXT_PUBLIC_FOO)`.
 * The no-value form (`requireEnv('FOO')`) reads `process.env` at runtime and is
 * therefore SERVER/INFRA ONLY - it silently yields `undefined` in a client bundle.
 * Server callers in this repo pass the value explicitly too (e.g.
 * `requireEnv('APP_URL', process.env.APP_URL)`); that is intentional and safe, and
 * keeps a call site correct if it is ever moved into client code.
 *
 * For values whose absence should be a no-op rather than an error, read them
 * directly with `?? ''` (or `?? undefined`) at the call site - also with no brand
 * fallback. (A dedicated `optionalEnv` helper was dropped as it had no callers.)
 *
 * Unset, empty, AND whitespace-only values are all treated as missing, so a secret
 * accidentally set to a blank/space string fails loud instead of producing a
 * malformed URL/ARN downstream.
 *
 * @param name  The variable name, used in the error message.
 * @param value Optional explicit value (required in client code for inlining).
 *              When omitted, falls back to reading `process.env[name]`.
 */
export function requireEnv(name: string, value?: string): string {
  const resolved = value ?? process.env[name];
  if (resolved === undefined || resolved.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `This value has no default — set it in your environment or SST secrets.`
    );
  }
  return resolved;
}
