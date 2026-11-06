# JA4 forwarding for authentication

The hosted router forwards CloudFront-generated JA4 on the paths listed in
`AUTH_NETWORK_PATHS` (`infra/authNetworkForwarding.ts`): `/api/auth/*`,
`/api/otc/*` and `/api/oauth/*` cover OAuth callbacks, email-code verification
and OAuth token/device sign-ins; `/api/subscriptions/*`,
`/api/organizations/subscriptions/*` and `/api/stripe/*` cover the checkout
routes, whose risk checks and Stripe risk metadata read the same network fields.
`infra/__tests__/authNetworkPathCoverage.test.ts` fails when a route starts
reading network meta outside those patterns.
Existing signup and login capture stores the value; no new blocking rule is added.
Old signup records remain unchanged, and HTTP or otherwise unavailable fingerprints
remain null. Self-hosted requests do not gain a trusted fingerprint from this change.

The authentication behaviors inherit the router's cache policy, methods and edge
functions. Their origin request policy forwards all viewer headers, cookies and
query strings, plus generated JA4, IP, ASN and country. The default behavior keeps
its managed policy, including S3's filtering of response override query parameters.
CloudFront does not generate viewer city, region or coordinates on the
authentication behaviors, so code under these paths must not rely on geo headers.
Shared development routers must receive this change through their owning stage.

Real ASN values also switch on signup checks that were dormant while
`network.asn` was always null on deployed stages. On these routes, email-code
and self-serve OAuth signups enforce the admin `maxSignupsPerAsnPerHour` cap
(`apps/client/server/auth/signupNetworkLimits.ts`), which refuses signups with a
429 once a non-zero cap is exceeded. Datacenter networks add `datacenterNetwork`
risk points (`b4m-core/services/src/userService/signupRiskScore.ts`), and signup
clustering gains `asn` keys. Check that setting in each environment before
deploying.

The router request function must stay under CloudFront's 10,240-byte limit
(`CLOUDFRONT_FUNCTION_MAX_BYTES` in `infra/routerFunctionCode.ts`). With the JA4
injection it is about 9.4 KB, so measure the minified size before adding more
injected code.

## Sharing the origin request policy

CloudFront allows 20 custom origin request policies per account by default, and
each stage that owns its router creates one for these behaviors. Before an account
runs many previews, create one shared policy and set
`AUTH_NETWORK_ORIGIN_REQUEST_POLICY_ID` to its id in the deployer's environment.
Stages then attach that policy and create none of their own; the next deploy of
an existing stage deletes its own copy. The configuration must match
`AUTH_NETWORK_HEADERS` in `infra/authNetworkForwarding.ts`:

```bash
aws cloudfront create-origin-request-policy --origin-request-policy-config '{
  "Name": "bike4mind-auth-network",
  "Comment": "Forward trusted connection metadata on authentication requests",
  "HeadersConfig": {
    "HeaderBehavior": "allViewerAndWhitelistCloudFront",
    "Headers": { "Quantity": 4, "Items": [
      "CloudFront-Viewer-Address", "CloudFront-Viewer-ASN",
      "CloudFront-Viewer-Country", "CloudFront-Viewer-JA4-Fingerprint"
    ] }
  },
  "CookiesConfig": { "CookieBehavior": "all" },
  "QueryStringsConfig": { "QueryStringBehavior": "all" }
}' --query OriginRequestPolicy.Id --output text
```

When `AUTH_NETWORK_HEADERS` changes, update the shared policy in each account too.

SST's lazy router preserves the viewer domain in `x-forwarded-host`, then selects
the URL origin using `cf.updateRequestOrigin`. The request-function transform
explicitly sets `hostHeader` to the destination domain; relying on the implicit
default caused Lambda URL access-denied responses on the preview when viewer
Host forwarding was enabled. The transform fails deployment if SST's URL-origin
helper changes shape, so an upgrade requires reviewing this compatibility step.
This avoids a new Lambda@Edge function.
On the authentication behaviors, CloudFront overwrites a supplied JA4 with its
computed value before invoking the CloudFront Function. The function preserves
that value. It removes JA4 on other paths and ambiguous paths that could differ
after CloudFront path normalization.
Origin verification continues to reject requests that bypass the distribution.

References:

- [CloudFront connection headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/adding-cloudfront-headers.html)
- [Dynamic origin hostname behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html)

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
authentication and checkout behaviors to the default managed policy if routing regresses.
