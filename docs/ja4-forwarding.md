# JA4 forwarding for authentication

The hosted router forwards CloudFront-generated JA4 on `/api/auth/*`,
`/api/otc/*` and `/api/oauth/*`. These paths cover OAuth callbacks, email-code
verification and OAuth token/device sign-ins.
Existing signup and login capture stores the value; no new blocking rule is added.
Old signup records remain unchanged, and HTTP or otherwise unavailable fingerprints
remain null. Self-hosted requests do not gain a trusted fingerprint from this change.

The authentication behaviors inherit the router's cache policy, methods and edge
functions. Their origin request policy forwards all viewer headers, cookies and
query strings, plus generated JA4, IP, ASN and country. The default behavior keeps
its managed policy, including S3's filtering of response override query parameters.
Shared development routers must receive this change through their owning stage.

SST's lazy router preserves the viewer domain in `x-forwarded-host`, then selects
the URL origin using `cf.updateRequestOrigin({ domainName: ... })`. Under AWS's
documented contract, that sets the origin Host to the destination domain even
when the policy forwards viewer Host. This avoids a new Lambda@Edge function.
The viewer-request function removes supplied JA4 before CloudFront adds its own.
Origin verification continues to reject requests that bypass the distribution.

References:

- [CloudFront connection headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html)
- [Dynamic origin hostname behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html)
- [Generated headers and viewer-request processing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)

## Preview verification before production

Local tests check configuration and forged-header removal. They cannot establish
AWS's actual header generation or dynamic origin behavior. Deploy to a preview
stage and verify all of the following before promoting:

1. Complete a real HTTPS signup using email code and a separate OAuth signup.
   Verify `signupMeta.ja4` and the signup AuthEvent have valid fingerprints.
2. Complete a login and check the login AuthEvent. Verify the public hostname,
   cookies and OAuth redirects still work; a wrong origin Host usually causes 403s.
3. Repeat a login through a client that sends a syntactically valid forged
   `CloudFront-Viewer-JA4-Fingerprint` header. The recorded value must be the
   CloudFront-generated fingerprint, never the supplied value. Verify duplicate
   supplied headers cannot replace it either.
4. Exercise a bearer-authenticated request under `/api/auth/` and OAuth token/device
   sign-in. Confirm Authorization still reaches the app and the resulting login
   AuthEvents contain JA4. Do not log tokens or the origin secret.
5. Check a static asset and a user-uploaded file still load, with their existing
   content security headers. Check another API path still uses its existing behavior.
6. Request the function URL directly without the origin secret and confirm refusal.

AWS's CloudFront Function test API does not exercise origin modification, so a
passing function test does not replace this deployed verification. Roll back the
three authentication behaviors to the default managed policy if routing regresses.
