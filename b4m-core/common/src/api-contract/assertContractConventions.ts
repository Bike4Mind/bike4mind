import type { z } from 'zod';
import type { ConventionRule, EndpointContract, ResponseSpec } from './types';

/**
 * Structural enforcement of CONVENTIONS.md.
 *
 * The contract mechanism makes each endpoint single-sourced, but a contract
 * faithfully publishes whatever the handler happens to do - so promoting an
 * endpoint can cement an inconsistency into a spec we then owe compatibility on.
 * These assertions make the conventions hold by construction: a contract that
 * declares a non-conforming error body, an off-table status, or no scope fails
 * the build rather than reaching review.
 *
 * Runs at generate time (openapi/operations.ts), NOT at contract-array import
 * time, so a violation fails the spec build + tests rather than crashing every
 * runtime module that imports the `@bike4mind/common` barrel.
 */

/**
 * Statuses a public endpoint may declare (CONVENTIONS.md section 1).
 *
 * 402 is deliberately absent: insufficient credits is a 422 with an
 * `insufficient_credits` errorCode on every endpoint except /api/ai/tts, which
 * carries a `status-table` exemption. A status cannot be aliased the way a URL
 * or a field can, so a new endpoint choosing 402 must fail here rather than
 * quietly doubling the vocabulary.
 */
const ALLOWED_STATUSES = new Set([200, 201, 202, 204, 400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503]);

/** The one version root for new public endpoints (CONVENTIONS.md section 3). */
const VERSION_ROOT = '/api/v1/';

/**
 * Public paths that predate the single-root rule and are already published, so
 * they cannot move. FROZEN: entries are only ever REMOVED (when a path is retired
 * behind a sunset). Adding one is exactly the drift this gate exists to prevent -
 * a new endpoint goes under /api/v1/.
 */
const LEGACY_PUBLIC_PATHS: readonly string[] = [
  '/api/chat',
  '/api/ai/v1/tools',
  '/api/ai/v1/completions',
  '/api/ai/tts',
  '/api/ai/music',
  '/api/ai/sound-effects',
];

/** operationId becomes the SDK method name, so it must be a valid camelCase identifier. */
const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/;

/**
 * Diagnostic label in the error message. A superset of {@link ConventionRule}:
 * these three are enforced but not exemptable via `conventionExemptions`
 * (`error-envelope` uses the finer-grained per-response `bespokeErrorShape`).
 */
type ConventionLabel = ConventionRule | 'operation-id' | 'error-envelope' | 'rate-limit-headers';

function fail(contract: EndpointContract, rule: ConventionLabel, problem: string, remedy: string): never {
  throw new Error(
    `Contract "${contract.operationId}" (${contract.method.toUpperCase()} ${contract.path}) ` +
      `violates the public API convention [${rule}]: ${problem} ${remedy} ` +
      `See b4m-core/common/src/api-contract/CONVENTIONS.md.`
  );
}

/** A Zod object's field map, or undefined for any non-object schema (union, string, ...). */
function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  const shape = (schema as { shape?: unknown }).shape;
  return typeof shape === 'object' && shape !== null ? (shape as Record<string, z.ZodTypeAny>) : undefined;
}

/**
 * Does this response body carry the shared error envelope?
 *
 * Checked STRUCTURALLY rather than by identity with `ApiErrorSchema`, because the
 * conventions explicitly tell authors to extend the envelope with typed members
 * (`errorCode`, `provider`, ...) rather than bolt on ad-hoc top-level keys. An
 * identity check would reject exactly the pattern we ask for. The contract is:
 * a required `error` string, and `request_id` optional-if-present.
 *
 * Field-level `safeParse` rather than `_def` introspection so this does not break
 * on a Zod major that reshuffles internals.
 */
function carriesErrorEnvelope(schema: z.ZodTypeAny): boolean {
  const shape = shapeOf(schema);
  if (!shape) return false;

  const error = shape.error;
  if (!error || !error.safeParse('an error message').success || error.safeParse(undefined).success) return false;

  const requestId = shape.request_id;
  if (requestId && !(requestId.safeParse(undefined).success && requestId.safeParse('abc-123').success)) return false;

  return true;
}

/**
 * A >= 400 response whose body is JSON, so the envelope rule applies to it.
 *
 * A missing `schema` does NOT mean "not JSON": registerContract falls back to
 * `application/json` carrying an opaque binary schema, so treating schema-less as
 * exempt would let a forgotten `schema` on a 500 bypass the envelope gate AND
 * publish a JSON media type holding raw bytes. Only an explicit non-JSON
 * `contentType` opts out - which the schema-less check below forces authors to
 * declare.
 */
function isJsonErrorResponse(status: number, spec: ResponseSpec): boolean {
  return status >= 400 && (spec.contentType ?? 'application/json') === 'application/json';
}

export function assertContractConventions(contracts: readonly EndpointContract[]): void {
  for (const contract of contracts) {
    const exemptions = contract.conventionExemptions;
    // `scope-required` / `version-root` are contract-wide; `status-table` is keyed
    // by the individual status, so excusing 402 cannot also excuse an unrelated 418.
    const exempt = (rule: 'scope-required' | 'version-root') => Boolean(exemptions?.[rule]);
    const statusExempt = (status: number) => Boolean(exemptions?.['status-table']?.[status]);

    if (!CAMEL_CASE.test(contract.operationId)) {
      fail(
        contract,
        'operation-id',
        `operationId "${contract.operationId}" is not camelCase.`,
        'It becomes the SDK method name, so it must match /^[a-z][A-Za-z0-9]*$/.'
      );
    }

    if (
      !contract.path.startsWith(VERSION_ROOT) &&
      !LEGACY_PUBLIC_PATHS.includes(contract.path) &&
      !exempt('version-root')
    ) {
      fail(
        contract,
        'version-root',
        `path "${contract.path}" is outside the ${VERSION_ROOT}* version root.`,
        'New public endpoints live under /api/v1/. LEGACY_PUBLIC_PATHS is frozen - do not add to it.'
      );
    }

    // Scopes are only enforced for API-key auth: apiKeyAuth checks them, JWT auth
    // does not. Declaring them on a jwtOnly/public contract publishes an
    // x-required-scopes that nothing checks, which is worse than silence.
    if (contract.auth === 'apiKeyOrJwt') {
      if (!contract.scopes?.length && !exempt('scope-required')) {
        fail(
          contract,
          'scope-required',
          'an apiKeyOrJwt endpoint declares no scopes.',
          'Every API-key-callable endpoint declares at least one scope (OR semantics). If adding one now ' +
            'would 403 keys that work today, record that as a `scope-required` conventionExemption.'
        );
      }
    } else if (contract.scopes?.length) {
      fail(
        contract,
        'scope-required',
        `a ${contract.auth} endpoint declares scopes, which are never enforced for that auth mode.`,
        'Remove them, or switch the contract to apiKeyOrJwt.'
      );
    }

    // baseApi installs apiKeyRateLimit only for the api-key chain, so a jwtOnly or
    // public endpoint provably cannot emit the headers. Claiming otherwise is the
    // exact executeTool defect this flag replaced, and it IS derivable here.
    if (contract.emitsRateLimitHeaders && contract.auth !== 'apiKeyOrJwt') {
      fail(
        contract,
        'rate-limit-headers',
        `a ${contract.auth} endpoint sets emitsRateLimitHeaders, but apiKeyRateLimit only runs on the ` +
          'api-key chain, so it can never send them.',
        'Drop the flag; publishing a header the runtime cannot send is what this flag exists to prevent.'
      );
    }

    for (const [rawStatus, spec] of Object.entries(contract.responses)) {
      const status = Number(rawStatus);

      if (!ALLOWED_STATUSES.has(status) && !statusExempt(status)) {
        fail(
          contract,
          'status-table',
          `status ${status} is not in the shared status table.`,
          'Map the condition onto a table status so one condition means one status across the surface.'
        );
      }

      if (isJsonErrorResponse(status, spec) && !spec.bespokeErrorShape) {
        // A schema-less JSON error is published as an opaque binary body, which no
        // client can read an `error` out of. Force the author to say which it is.
        if (!spec.schema) {
          fail(
            contract,
            'error-envelope',
            `the ${status} response declares no schema but defaults to application/json.`,
            'Give it the error envelope, or set an explicit non-JSON `contentType` if it really returns raw bytes.'
          );
        }
        if (!carriesErrorEnvelope(spec.schema)) {
          fail(
            contract,
            'error-envelope',
            `the ${status} response body does not carry the shared error envelope (a required \`error\` string, ` +
              'with `request_id` optional if present).',
            'Extend the envelope with typed members rather than replacing it, or - if the shape genuinely ' +
              'cannot conform - set `bespokeErrorShape: "<reason>"` on that response.'
          );
        }
      }
    }
  }
}
