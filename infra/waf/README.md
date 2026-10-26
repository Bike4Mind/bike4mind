# WAF policy notes

## Sample policy and deployment-owned policies

The JSON file in this directory is a sample policy with round example rate
limits. It is not tuned for any particular deployment, and it is used by the
stage-owned ACLs only (PR previews, and dev when `WAF_WEB_ACL_NAME` is unset).
The production ACL, and the dev ACL when `WAF_WEB_ACL_NAME` is set, are managed
outside this stack and attached by name; see `infra/wafAssociation.ts`. A deployment supplies its own non-production policy
in one of two ways:

- overwrite `bike4mind-api-protection-dev.json` here before SST runs, or
- set `WAF_POLICY_DIR` to a directory holding a file with that same name
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

The policy runs `AWSManagedRulesBotControlRuleSet` at the `COMMON`
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

Re-run the read-only AWS
WAFv2 `CheckCapacity` API (`us-east-1`, `CLOUDFRONT` scope, with the emergency
IPSet ARN placeholder replaced by an existing IPSet ARN) after policy changes or
managed-rule updates. AWS optimizes combined rule capacity, so summing
individual statement costs overestimates it.

[WAF pricing](https://aws.amazon.com/waf/pricing/) adds a per-request charge for
each additional 500 WCU above 1,500. Bot Control also has its own per-ACL monthly
fee and inspected-request charges, separately from standard WAF and logging
charges. The scope-down reduces Bot Control inspected requests; Count does not
waive its fees. Each enabled stage or preview ACL incurs its own applicable
charges.
