# Shared preview load balancer for ChatCompletion

Every stage gives the ChatCompletion service its own internet-facing load balancer. A busy
preview tier runs dozens of stages at once, and each load balancer costs a fixed hourly rate
plus a public IPv4 address per availability zone whether or not the preview is used. Previews
can instead share one load balancer and add only a target group and host-based listener rules.

`infra/chatCompletion.ts` does this when `PREVIEW_CHAT_SHARED_LISTENER_ARN` is set on a
`pr<digits>` preview stage that also uses the shared certificate
(`PREVIEW_CHAT_ORIGIN_CERT_ARN`, see `infra/preview-shared-origin-certificate.md`):

- The Service gets no `loadBalancer`, so SST creates no load balancer, security group,
  listener or target group for it.
- The stage creates its own target group and attaches the ECS service to it.
- It adds two rules to the shared HTTPS listener, both matching the host
  `chat-origin-<SERVER_DOMAIN>`:
  - the stage's CloudFront origin-verify header, for `/api/ai/v1/completions`,
    `/api/embed/chat` and `/api/v1/turns`;
  - `/process` and `/health` from the VPC NAT egress IPs, for the frontend's quest dispatch and
    the status probe.

  With `DISABLE_ORIGIN_VERIFY=true` a single host-only rule replaces both.
- Rule priorities come from the PR number (`sharedRulePriorities` in
  `infra/previewSharedChatOrigin.ts`), so concurrent deploys never race for one.
- The stage still writes its own alias record for the host, now pointing at the shared load
  balancer, which it looks up from the listener ARN.
- A Service without a load balancer links no URL, so the frontend receives the origin as
  `CHAT_COMPLETION_ORIGIN_URL`, which `chatCompletionBaseUrl()` prefers.
- The stage adds no ingress rule to the VPC default security group; the shared load balancer's
  owner adds one for all previews.

The target group and rules are tagged `b4m:preview-stage=<stage>` and removed with the stage.

With the variable unset nothing changes. Production, staging, personal `sst dev` stages and
non-`pr<digits>` previews never read it.

## Ownership

The load balancer, its security group (port 443 from the CloudFront origin-facing prefix list
and the NAT egress IPs), the default security group's ingress rule on port 8080 from it, and the
HTTPS listener (shared wildcard certificate, fixed 403 default action) are owned by OpenTofu in
the private infrastructure repository. The listener ARN is a stack output, which the deployer
passes as `PREVIEW_CHAT_SHARED_LISTENER_ARN` on preview deploys only. No stage creates, changes
or deletes them.

## Limits

An Application Load Balancer holds a limited number of listener rules (100 by default,
adjustable) and target groups. Each preview uses two rules and one target group. Raise the
rules quota before the preview fleet approaches half of it.

A teardown that fails after its state is pruned leaves the stage's rules and target group on
the shared listener. They are found by the `b4m:preview-stage` tag and removed by the
deployer's preview sweep.

## Switching an existing preview

A preview that already has its own load balancer moves on its first deploy with the variable
set: SST deletes its load balancer and the alias record is updated in place to point at the
shared one. Chat on that preview can fail for a few minutes during that one deploy. To move a
preview back, unset the variable; its next deploy recreates its own load balancer.
