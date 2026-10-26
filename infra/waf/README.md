# WAF policy notes

## Sample policy and deployment-owned policies

The two JSON files in this directory are a sample policy with round example
rate limits. They are not tuned for any particular deployment. A deployment
supplies its own policy in one of two ways:

- overwrite `bike4mind-api-protection-prod.json` and
  `bike4mind-api-protection-dev.json` here before SST runs, or
- set `WAF_POLICY_DIR` to a directory holding files with those same two names
  (absolute, or relative to the repo root). See `resolveWafPolicyDir` in
  `infra/wafPolicy.ts`.

To check a deployment-owned policy against the structural invariants (rule
order, priorities, shadow rules staying in Count), point the suite at it:

```sh
WAF_POLICY_DIR=<dir> pnpm exec vitest run --dir infra wafPolicy
```

In that mode the tests that pin the sample's exact rate limits are skipped and
everything else is enforced. Do not copy a deployment-owned policy into this
directory and run the suite without `WAF_POLICY_DIR`: the sample-limit pins will
fail by design.

## Bot Control telemetry

Both stage policies run `AWSManagedRulesBotControlRuleSet` at the `COMMON`
inspection level, last at priority 30, with the group return action overridden
to `Count`. It cannot block, challenge, or CAPTCHA requests.

This is partial telemetry: earlier terminating Allow or Block rules prevent
Bot Control from seeing those requests. Inside the group, evaluation stops at
the first matching terminating rule before its result is converted to Count.
Later rules in the group do not produce metrics or labels for that request.
Collecting every matching rule's signals would require individual rule action
overrides to Count instead. See [AWS action override semantics](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-rule-group-override-options.html).

The scope-down skips the `/_next/static/` and `/_next/image` prefixes after URL
decoding, path normalization, and lowercasing. It does not exempt those paths
from earlier security rules.

## Capacity and cost

Read-only AWS WAFv2 `CheckCapacity` measurements on 2026-10-23, in `us-east-1`
with `CLOUDFRONT` scope, compared the policies before and after Bot Control:

| Policy                          | Before (WCU) | With Bot Control (WCU) | Increase |
| ------------------------------- | -----------: | ---------------------: | -------: |
| dev (also staging and previews) |        1,442 |                  1,496 |       54 |
| production                      |        1,418 |                  1,472 |       54 |

The API measured the complete rule lists, replacing the emergency IPSet ARN
placeholder with an existing CloudFront IPSet ARN. AWS optimizes combined rule
capacity, so summing individual statement costs overestimates these policies.
These are historical measurements from before the additional path-scoped rate
rules. They do not describe the current policy's capacity or pricing tier.
Re-run `CheckCapacity` after policy changes or managed-rule updates;
these measurements are not a permanent capacity guarantee.

[WAF pricing](https://aws.amazon.com/waf/pricing/) adds a per-request charge for
each additional 500 WCU above 1,500. Bot Control also has its own per-ACL monthly
fee and inspected-request charges, separately from standard WAF and logging
charges. The scope-down reduces Bot Control inspected requests; Count does not
waive its fees. Each enabled stage or preview ACL incurs its own applicable
charges.
