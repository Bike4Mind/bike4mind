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

## Ownership

The function `bike4mind-preview-shared-viewer-response` is owned by OpenTofu in the private
infrastructure repository, whose previews account stack vendors a copy of the code as
`preview-shared-viewer-response.js` and exposes the ARN as a stack output. The deployer
passes that ARN as `PREVIEW_SHARED_RESPONSE_FUNCTION_ARN` on preview deploys only.
Existing previews pick it up on their next deploy; SST deletes their own response function
as part of that update.

No stage creates, changes or deletes the function, and tearing a preview down leaves it in
place. Nothing in this repository writes to it either.

## Keeping it current

This is the operational risk of sharing: a preview's own function was regenerated on
every deploy, the shared one is not. Whenever `USER_FILE_CSP`, `USER_FILE_MARKER_HEADER`,
`userFileCspInjection` or `noindexResponseInjection` change in
`infra/routerFunctionCode.ts`, regenerate the vendored copy and re-apply that stack;
until then every preview on the shared function serves the old headers:

```sh
node -e 'import("./infra/routerFunctionCode.ts").then(m => process.stdout.write(m.sharedPreviewResponseFunctionCode()))' \
  > <infrastructure repo>/<previews account stack>/preview-shared-viewer-response.js
```

A `userFileCdnPrefixes` change is already covered, because each stage's own viewer-request
function stamps the marker header from the current list; regenerate anyway so the vendored
copy matches the source.

Regenerate from `main` after the change merges. Publishing a PR branch's code puts unmerged
code on every preview in the account, so a PR that changes the response code cannot be
checked on its own preview; check it on a stage without the variable set instead.
The tofu plan shows a code diff whenever LIVE drifts from the vendored copy, so a hand
change to the function surfaces on the next plan of that stack.

`infra/__tests__/routerSharedResponseFunction.test.ts` pins the shared code to what a
preview's own function would contain.
