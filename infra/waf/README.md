# WAF policy notes

## Sample policy and deployment-owned policies

The JSON file in this directory is a sample policy with round example rate
limits. It is not tuned for any particular deployment, and it is used by the
stage-owned ACLs only (dev, staging and PR previews without `WAF_WEB_ACL_NAME`).
Any stage that sets `WAF_WEB_ACL_NAME` attaches an ACL managed outside this
stack, found by name, and production requires it; see `infra/wafAssociation.ts`. A deployment supplies its own non-production policy
in one of two ways:

- overwrite `bike4mind-api-protection-dev.json` here before SST runs, or
- set `WAF_POLICY_DIR` to a directory holding a file with that same name
  (absolute, or relative to the repo root). See `resolveWafPolicyDir` in
  `infra/wafPolicy.ts`.

## External ACL contract and handoff

Set `ENABLE_WAF=true` and `WAF_WEB_ACL_NAME` to attach an existing
CloudFront-scope ACL in us-east-1. Production requires both settings and fails
deployment when either is missing. Other stages use their own ACL when no
external name is supplied.

The external ACL must already have logging enabled to one CloudWatch log group
in us-east-1 whose name starts with `aws-waf-logs-`. This stack reads the logging
configuration without managing it. Missing logging, failed lookups, and S3 or
Firehose destinations fail deployment: the dashboard and production signup
edge-signal alarm require CloudWatch Logs. The dashboard IAM policy and the
signup filter follow the selected destination, including custom group names.

Before production adopts the external ACL:

1. Deploy the retention change in PR #5805 to the existing production stack.
   Confirm the deployed state retains the ACL, IP set, log group, logging
   configuration and rate-limit alarm topic before removing their declarations.
2. Prepare external ownership of those retained resources. Avoid concurrent
   writes from two stacks; remove retained resources from the original stack
   before importing them into the new owner's state.
3. Create and verify replacement rate-limit alarms under distinct physical names
   before deploying this association change. The six old rate-limit alarms are
   deliberately **not retained** by #5805 and will be deleted. Importing those
   same alarms into another stack first does not prevent the original stack
   from deleting them.
4. Keep the production rate-limit SNS topic at its existing name,
   `<app>-production-waf-ai-rate-limit-alarm`, and set `WAF_WEB_ACL_NAME` in the
   deploy environment. The topic lookup must succeed before deployment.

This stack continues to own production alert delivery, its DLQ and alarms, the
out-of-band email topic, and the signup edge-signal filter and alarm. Only
production creates these resources. Other stages using an external ACL read
its logging configuration but do not look up the production alarm topic.

If deployment fails while reading the external logging configuration, verify
the selected ACL's logging destination and the deployer's read permissions.
If signup alerts stop after moving logging, redeploy this stack to refresh the
filter and dashboard IAM policy against the new destination.

To check a deployment-owned policy against the structural invariants (rule
order, priorities, shadow rules staying in Count), point the suite at it:

```sh
WAF_POLICY_DIR=<dir> pnpm exec vitest run --dir infra wafPolicy
```

In that mode the tests that pin the sample's exact rate limits are skipped and
everything else is enforced. Do not copy a deployment-owned policy into this
directory and run the suite without `WAF_POLICY_DIR`: the sample-limit pins will
fail by design.

## Count-mode rate rules

Three rate rules ship in Count with round example limits (a deployment sets its own), ahead of every enforcing rate rule (priorities 4 to 6 in both stages):

| Rule                      | Scope                        | Key | Limit | Window |
| ------------------------- | ---------------------------- | --- | ----: | -----: |
| `otc-send-rate-limit`     | `/api/otc/send` prefix       | IP  |    20 |  600 s |
| `credits-read-rate-limit` | GET `/api/v1/credits` prefix | IP  |    50 |  300 s |
| `otc-send-asn-rate-limit` | `/api/otc/send` prefix       | ASN |   100 |  600 s |

To enforce one, change its `Action` from `{ "Count": {} }` to the 429 `Block` used by the other rate rules. The block alarm is created from the policy, so no other change is needed. WAF accepts a minimum limit of 10 per window and the windows 60, 120, 300 and 600 seconds.

Each rule skips addresses in the rate-exempt IP set (`rate-exempt-ip-prod` in production). Its addresses come from the `WAF_RATE_EXEMPT_IPS` deploy variable (comma-separated IPv4 or CIDR, empty keeps a TEST-NET placeholder). The set only stops these rules from counting an address; the address still passes through every other rule.

These Count rules run before all enforcing rate rules, including the blanket API limit, so rate-blocked senders still contribute to the ASN counter. Earlier terminating rules, such as the emergency IP block, still stop evaluation. Count metrics report requests above the configured threshold, not total per-ASN volume.

An ASN-keyed rule shares one counter across every client on a network, so size its limit above legitimate peak traffic and read the Count metric before enforcing.

## ACFP, IP reputation and label forwarding

`AWSManagedRulesACFPRuleSet` runs at priority 27, scoped to `/api/otc/`, with the group return action overridden to `Count`. It is billed per inspected request, and without WAF token integration it emits little beyond token-absent labels.

`AWSManagedRulesAmazonIpReputationList` counts instead of blocking on the stage-owned ACL (dev, staging, previews), so these stages no longer enforce it. This keeps the reputation signal visible without blocking shared-egress clients while the rule is evaluated.

`forward-anon-ip-label` (31) and `forward-bot-signal-label` (32) are Count rules that match the AnonymousIPList label and the Bot Control `bot:` label namespace and insert a request header. AWS WAF prefixes inserted headers with `x-amzn-waf-`, so the app reads `x-amzn-waf-x-waf-anon-ip` and `x-amzn-waf-x-waf-bot-signal` (`apps/client/server/auth/networkMeta.ts`). `infra/web.ts` sets `WAF_LABEL_FORWARDING` only when the stage owns the ACL; an externally managed ACL must add these two rules itself before that flag applies to it. `block-forged-waf-forwarding-headers` (28) blocks any viewer request that already carries either inserted header set to `1`: WAF inserts them only after inspection, so rule 28 never sees a genuine one.

## Bot Control telemetry

The policy runs `AWSManagedRulesBotControlRuleSet` at the `COMMON`
inspection level, at priority 30, with the group return action overridden
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
