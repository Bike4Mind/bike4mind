# Shared preview viewer-response function

CloudFront caps the number of CloudFront Functions an account may hold, and the cap
cannot be raised. SST's Router creates two per stage: the viewer-request function
(routing table plus the per-stage origin-verify secret, so it cannot be shared) and a
viewer-response function. On preview stages the response code is the same everywhere:
the user-file CSP backstop plus `x-robots-tag: noindex`. So previews can all attach one
account-level response function instead of each creating their own, and a preview then
costs one function instead of two.

`infra/router.ts` does this when `PREVIEW_SHARED_RESPONSE_FUNCTION_ARN` is set on a
preview stage (`pr<digits>` or `IS_PREVIEW=true`): it omits `edge.viewerResponse`, so
SST creates no `RouterCloudfrontFunctionResponse`, and appends a `viewer-response`
association to the distribution's default behaviour pointing at that ARN. With the
variable unset nothing changes. Production, staging, shared-dev and personal `sst dev`
stages always keep their own function.

## One-time setup per preview account

1. With that account's credentials, run
   `node scripts/preview-shared-response-function.mjs`. It creates (or updates) the
   function `bike4mind-preview-shared-viewer-response` from
   `sharedPreviewResponseFunctionCode()` in `infra/routerFunctionCode.ts`, publishes it
   and prints its ARN.
2. Set `PREVIEW_SHARED_RESPONSE_FUNCTION_ARN` to the ARN the script printed, in the
   deployer's environment for preview deploys only.
3. Existing previews pick it up on their next deploy; SST deletes their own response
   function as part of that update.

The function is deployed by hand and never by a stage, so no preview can create, change
or delete it, and tearing a preview down leaves it in place.

## Keeping it current

This is the operational risk of sharing: a preview's own function was regenerated on
every deploy, the shared one is not. Whenever `USER_FILE_CSP`, `userFileCdnPrefixes`,
`userFileCspInjection` or `noindexResponseInjection` change in
`infra/routerFunctionCode.ts`, run the script again in each preview account before (or
with) the deploy that carries the change; until then every preview on the shared
function serves the old headers. `--check` exits non-zero when the LIVE code differs
from the current source, so the deployer can gate on it; `--print` shows the code that
would be published.

`infra/__tests__/routerSharedResponseFunction.test.ts` pins the shared code to what a
preview's own function would contain.
