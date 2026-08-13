# API endpoint contracts

A **contract** is the single source of truth for a public API endpoint. It is pure
data - method, path, `operationId`, auth mode, scopes, request/response Zod schemas,
and doc metadata - with no coupling to any transport. One contract is derived into
three things so they can never drift:

1. the **OpenAPI spec** (`/api/v1/openapi.json` + Scalar UI at `/api/v1/docs`),
2. the **Next.js route** (`nextRouteForContract`),
3. the **Lambda Function-URL route** (`defineLambdaRoute`), for endpoints that can't
   be served by Next.js.

Reference example: `contracts/chat.contract.ts` + `apps/client/pages/api/chat.ts`.

## Expose a public endpoint (6 steps)

1. **Put the request/response schemas in `@bike4mind/common`** (`src/schemas/`), as
   plain Zod. The handler must validate with the *same* object the contract uses.
2. **Write the contract** in `src/api-contract/contracts/<name>.contract.ts` with
   `defineEndpoint({...})`. Add it to `contracts/index.ts` (`CONTRACTS`).
3. **Wire the handler:** `nextRouteForContract(contract).post((req, res) => { ... })`.
   The body is validated and available as `req.validated`; scopes come from the
   contract. (Lambda transport: `defineLambdaRoute(contract, handler)`.)
4. **Regenerate the spec:** `pnpm turbo:openapi:generate` and commit
   `apps/client/public/openapi.json`. CI drift-gates it.
5. **Delete the endpoint's section** from the hand-written reference
   (`apps/client/app/components/admin/content/apiReferenceContent.ts`) so the two
   doc systems never contradict.
6. **Verify:** `pnpm --filter @bike4mind/common typecheck && redocly lint` +
   the handler's tests.

## Rules

- **No `.catch()` / top-level `.transform()` in a public request schema.** Both
  silently mutate caller input (fail-quiet) and are opaque to zod-to-openapi. Use
  `.default()` for defaults and do domain filtering/coercion in the handler
  (e.g. `filterKnownTools`). This keeps the schema OpenAPI-representable with no doc
  projection. `requestDoc` on the contract exists only as a rare escape hatch.
- **Never call `.openapi()` in a shared schema or a contract file.** That method
  only exists after `extendZodWithOpenApi` runs (openapi/registry.ts), which the
  runtime handlers do not import - calling it there crashes the endpoint on import.
  Annotation happens in the OpenAPI layer (`registerContract`) only.
- **In contract + openapi files, import the SPECIFIC schema file, not the barrel.**
  Use `from '../../schemas/tools'`, not `from '../../schemas'`. The barrel re-exports
  everything, including modules that import other `@bike4mind/*` packages (e.g.
  `actions.ts` -> `@bike4mind/hearth`). The CI `OpenAPI Spec` job regenerates with
  `pnpm install` only - **no package is built** - so a barrel import drags in an
  unbuilt dist and crashes generation (passes locally, where dists exist).
- **Responses assembled inline** in a handler are validated against the contract in
  non-prod by both adapters, so drift shows up in tests. Keep the response schema
  accurate.
- **422 is auto-documented.** A contract with a `request` schema returns 422 on
  validation failure (both adapters guarantee it), so `registerContract` injects a
  standard 422 response - you do not (and should not) declare it per endpoint.
  Declare your own `422` only if the shape genuinely differs.
- **Naming / versioning (forward-only):** new public endpoints under `/api/v1/*`,
  stable camelCase `operationId` (it becomes the SDK method name), `*.contract.ts`
  file. Never rename a live URL - alias instead.
- **Public == API-key-callable.** Only endpoints an API key can call belong in the
  spec. Internal SPA-backend routes stay as plain handlers.
