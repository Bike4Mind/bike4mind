# Shared preview certificate for the ChatCompletion load balancer

Every stage whose app domain SST manages serves the ChatCompletion load balancer over HTTPS
on its own host name. By default the stage requests an ACM certificate for that name and
deletes it on `sst remove`. ACM limits how many certificates a region may request per year,
and a busy preview tier creates and removes stages all day, so previews can share one
certificate instead.

`infra/chatCompletion.ts` does this when `PREVIEW_CHAT_ORIGIN_CERT_ARN` is set on a preview
stage (`pr<digits>` or `IS_PREVIEW=true`):

- No certificate is requested. The HTTPS listener uses the ARN from the variable.
- The host name becomes `chat-origin-<SERVER_DOMAIN>` instead of
  `chat-origin.app.<SERVER_DOMAIN>`. With `SERVER_DOMAIN=pr123.preview.example.com` that is
  `chat-origin-pr123.preview.example.com`, a single label under the preview domain, which a
  wildcard certificate for `*.preview.example.com` covers.
- The stage still writes its own alias record for that name and removes it with the stage.

With the variable unset nothing changes. Production, staging and personal `sst dev` stages
never read it.

## Ownership

The certificate is owned by OpenTofu in the private infrastructure repository, in the same
region as the preview stages, and its ARN is a stack output. The deployer passes that ARN
as `PREVIEW_CHAT_ORIGIN_CERT_ARN` on preview deploys only. No stage creates, changes or
deletes the certificate, and tearing a preview down leaves it in place.

## Switching an existing preview

A preview that already holds its own certificate changes host name on the first deploy with
the variable set. The listener takes the shared certificate before the frontend function
picks up the new name, so chat on that preview can fail for a few minutes during that one
deploy. A preview first deployed with the variable set is unaffected.
