# Rolling out a new API-key scope

`requiredScopes` on `baseApi()` is opt-in and defaults open: a route that declares
none authorizes any valid API key. Closing that gap on a route that already has
keys in circulation is not a one-line change, because **a key holds only the scopes
it was minted with**. Declaring the gate and deploying it 403s every existing
caller the same minute.

This is the sequence that avoids that, and the mechanism that supports it.

## The four parts of adding a scope

1. **Add the enum value** to `ApiKeyScope`
   (`b4m-core/common/src/types/entities/UserApiKeyTypes.ts`).
2. **Register it in a mint catalog** (`apps/client/app/constants/apiKeyScopes.ts`).
   An enum value that is in no catalog is unmintable, so no key can ever hold it and
   every route requiring it is permanently 403. `apiKeyScopes.test.ts` fails the build
   on an unregistered value; the three homes are `USER_API_KEY_SCOPES` (self-service),
   `ADMIN_ONLY_API_KEY_SCOPES` (admin-provisioned), and `NON_MINTABLE_API_KEY_SCOPES`
   (granted by a flow of its own, never by a mint route).
3. **Declare `requiredScopes`** on the routes it governs.
4. **Re-mint the keys already in production** before that gate starts rejecting.

Steps 3 and 4 are ordered by the staging mechanism below. Steps 1 and 2 are safe to
land on their own: a scope nobody requires yet changes no request's outcome.

Two generated/declared files trail step 1 and are gated in CI, not locally:

- `apps/client/public/openapi.json` is committed, and its `info.description` publishes
  the enum verbatim (`ALL_API_KEY_SCOPES`). Adding a value drifts the snapshot - run
  `pnpm turbo:openapi:generate` and commit the result, or the `OpenAPI Spec` job fails.
- `infra/deploy-contract.json` must name any `process.env` that `infra/` reads at deploy
  time. Threading a new lever through `infra/web.ts` alone fails `Core Build`.

## Splitting read from spend

Where a surface both reads state and commissions billable work, give it two scopes,
not one. A key that only reads is then *structurally* unable to spend - which is what
lets an agent hold one. `optihashi:read` / `optihashi:compute` is the reference pair.

Keep the suffix honest: the New-Key modal builds its "Read-only" and "Read & write"
presets from the `:read` and `:write` suffixes, so a spend scope must carry neither,
or it rides into a preset users reasonably expect to be cheap.

A scope authorizes; it never entitles. The feature's own entitlement check still runs
and can refuse on its own.

## Staging the gate

`API_KEY_SCOPE_STAGING` is a comma-separated list of scopes whose gates are still
rolling out:

```
API_KEY_SCOPE_STAGING=optihashi:read,optihashi:compute
```

It reaches the API Lambda through `infra/web.ts`, so setting it takes a deploy of the
target stage - the same as any other lever there.

While a scope is listed, a route requiring it lets through a key that lacks it and
logs `API key scope check missed but staged - allowing` with the key id, the held
scopes, and the endpoint. Every hit is a production key that will start failing the
day the entry is removed.

That log is a *confirmation* of the backlog, not the way to discover it. Discovery by
traffic is incomplete on its own: a key that fires monthly never appears in a
two-week staging window, so a quiet log cannot distinguish "everyone re-minted" from
"the quarterly job has not run yet". Size the population up front with the
**scope preflight** (Admin -> Reliability / Incident Ops -> API Key Scope Preflight,
backed by `GET /api/admin/api-keys/scope-preflight`). Given an endpoint prefix and the
scopes you intend to require, it reads the history in `ApiKeyUsageLog` - up to that
collection's 90-day TTL - and lists the keys that have actually called those routes,
marking each as would-403, surviving-only-on-staging, or already fine. It caps the
result and says so when the cap is hit, so treat a truncated list as partial and
narrow the prefix. It reaches its verdict by calling
`decideScopeGate` - the same function the runtime gate calls - so it cannot drift from
enforcement.

If the preflight returns nothing, there is no grandfathered population and the whole
staging sequence below can be skipped: declare the gate and enforce in one step.

Two things it deliberately will not do:

- **It will not stage `admin:*`, `cc-bridge:connect`, `embed:chat`, or
  `overwatch-ingest:write`.** Staging `admin:*` would open every admin-gated route to
  any valid key; the others are bound to credentials minted with them, so there is no
  grandfathered population to rescue. Listing one logs it as rejected and enforces
  normally.
- **It will not silently accept a typo.** An entry that is not a real scope value is
  reported in the same warning and ignored, so a misspelling fails closed rather than
  reading as "that gate is staged".

Staging is all-or-nothing per route. `requiredScopes` is OR semantics, so a route is
in its grace period only while *every* alternative it accepts is staged - if even one
is already enforced, a key that legitimately needs the route could have been minted
with it, and holding none of them is a real miss.

Unset (the default) means every declared gate enforces. Enforcement is the default
state; staging is the temporary one.

Staging applies to the `baseApi` gate only. The other scope check - `verifyApiKey`
(`apps/client/server/cli/auth.ts`), behind public contract routes, the cc-bridge, and
embed keys - always enforces. It needs no staging: every gate it runs is bound to a
credential minted with that exact scope, or to an endpoint that shipped with its scope
from the start, so nothing there was ever grandfathered. A contract route declaring a
brand-new scope is a brand-new endpoint with no keys in circulation.

## The rollout

1. Land the enum value and the catalog registration.
2. Run the **scope preflight** against the routes you are about to gate. If it returns
   no keys, skip to step 6 and enforce in one step - there is nobody to grandfather,
   and staging a gate with no population to protect just means it never enforces.
   Otherwise the result is your re-mint list.
3. Set `API_KEY_SCOPE_STAGING` to the new scope(s) on the target stage.
4. Land `requiredScopes` on the routes. Nothing breaks - misses are logged, not rejected.
5. Re-mint the keys from step 2 with their owners. Watch
   `API key scope check missed but staged - allowing` as a cross-check that the list was
   complete - a `keyId` there that step 2 did not name means the preflight window was too
   short, so widen it rather than trusting the log alone.
6. Remove the entry from `API_KEY_SCOPE_STAGING`. The gate is now live.

Do not skip the last step quietly. A scope left in the list forever is a gate that has
never once enforced.

## Troubleshooting

| Symptom | Cause |
|---|---|
| A key with the right scope still gets 403 | The feature's entitlement check refused, not the scope gate. Scopes authorize; they do not entitle. Look for the feature's own gate. |
| A new scope never appears in the New-Key modal | It is registered in `ADMIN_ONLY_API_KEY_SCOPES` or `NON_MINTABLE_API_KEY_SCOPES`, or it is in `DEDICATED_FLOW_SCOPES` (which the generic modals filter out). |
| Staging seems to have no effect | Check the log for `Ignoring unstageable or unknown API key scopes in staging list`, and confirm every scope the route accepts is listed - one unstaged alternative enforces the whole gate. |
| The browser UI breaks after declaring `requiredScopes` | It should not: the gate runs only for requests authenticated by an API key, never for JWT/session callers. A UI break points at something other than the scope gate. |
