# Automated containment

Turns an abuse assessment's verdict into the same Contain an admin would run from the
users list (suspend, cancel Stripe subscriptions, remove a positive balance, revoke API keys,
end sessions, optionally block owned email domains). It runs as the `auto-containment` system actor, and its audit
reason cites the assessment and the evidence.

## Pieces

| File                                                                          | Role                                                                                                                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.ts`                                                                   | Pure decision: `decideContainment(assessment, detection, config)` -> contain or skip-with-reason.                                                              |
| `executor.ts`                                                                 | `applyAutoContainment`: config, idempotent decision record, hourly cap, then shadow or enforce.                                                                |
| `strongLink.ts`                                                               | On signup, a new account whose signup IP matches a blocked account within the window gets a `signupIpLinkedToBlocked` detection, assessed and decided at once. |
| `packages/server-utils/src/security/abuseAssessment/linkedAccountEvidence.ts` | The `groupEvidence` producer the assessment sees (linked accounts, landing notebook, settlement over hold, signup method and network).                         |

## Decision API

The judgment is the existing abuse assessment (`executeDecision` against the Decisions
API, model pinned in `abuseAssessmentConfig`, e.g. a Jev release). It keeps its budget,
call cap and per-(detection, evidence, policy, model) cache. This module only reads its
verdict, so the assessment stays advisory everywhere else.

## Gates (setting `autoContainmentConfig`)

| Field                     | Default  | Why                                                                                                                                                                                                                                             |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                    | `shadow` | `off` / `shadow` (record only) / `enforce`.                                                                                                                                                                                                     |
| `minConfidence`           | 0.9      | Only near-certain `abuse` verdicts act.                                                                                                                                                                                                         |
| `maxPerHour`              | 5        | Fixed one-hour window per mode, so shadow measures the real cap without spending enforce's first hour after a flip; over it the decision is recorded `capped` and re-evaluated once the window resets.                                          |
| `maxAccountsPerDetection` | 5        | A larger cohort always goes to an admin.                                                                                                                                                                                                        |
| `blockEmailDomains`       | false    | Owned domains only; public mailbox providers are never blocked. It refuses every new signup on the domain, so one false positive on a shared corporate or campus network blocks the whole domain: leave it off until shadow precision is known. |
| `strongLinkWindowHours`   | 72       | 0 turns the signup rule off.                                                                                                                                                                                                                    |

Only detections whose `wouldAction` is contain or suspend, with no admin verdict yet, are
eligible, and the verdict is re-read right before the Contain runs (a late ruling records
`withdrawn`).

Each revision has one shared graduated claim and one independent Contain claim in `AutoContainmentDecision`. A campaign
detection that gains members after a decision is decided again for the new members only. The run
claims the decision (`pending`) before it takes an hourly slot, so losing the claim spends nothing.
The bulk call carries `auto-containment:<detectionId>:<revision>` as its idempotency key.

A claim left `pending` for 15 minutes (the run died, or the Contain ran out of time budget) is
reclaimed by the next run on the detection and retried with the same key; the bulk path skips users
it already contained. A Contain with no eligible account (admins, deleted users) records `failed`.

## Link rules

When the model abstains (unknown, stale, `insufficient_evidence`, or below `minConfidence`) or the tier
the detection maps to is off, on a graduated or a Contain detection, deterministic rules in `linkRules.ts`
may decide Limit or Hold signup grant instead, under the same mode, rule-tier, review-only, verdict,
account-count and rollout gates. A `legitimate_automation` judgment is a positive call, not an
abstention, so a rule never overrides it, whatever its confidence or age. Facts are loaded
by `packages/server-utils/src/security/autoContainment/linkRuleFacts.ts`, failing closed per fact.
Paying and partner-domain accounts are never touched, and a rule never decides Contain. A rule's tier is
independent of the tier the detector's action maps to, so a rule may decide Limit on a detection whose own
mapping is a lighter tier (holdGrant, review, verify).

| Rule                | Fires when                                                                                    | Tier                              |
| ------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| `bannedSameDevice`  | Same uncommon device as a banned account, and credits spent in the last 30 days.              | limit                             |
| `sharedOwnedDomain` | 3+ accounts on one owned mail domain within the strong-link window, 2+ of them spent credits. | limit if it spent, else holdGrant |
| `heldSignupDomain`  | The address's domain (or a parent) was confirmed blocked by an admin, not by automation.      | holdGrant                         |

Decisions record `decidedBy` (`model` or `link_rule`), the fired `linkRules`, and the model's own
`modelJudgment`, so model abstention on rule-decided cases is measurable. A rule-decided row's `confidence`
is still the model's, so verdict grading scores those rows as their own `<mode>:link_rule` variant with
no confidence. `linkRules.enabled` (default on) turns the rules off.

The first graduated decision on an account stands for the detection: any earlier row of any tier or
revision covers that account for every graduated tier, so a later model-decided Limit after a rule's Hold
signup grant (or the reverse) records nothing for it. Only Contain passes through, and only an earlier
Contain row covers an account for Contain.

## Shadow grading

Shadow writes `would_contain` rows without touching accounts. Joining them by
`detectionId` to the admin verdict on the same detection gives precision (admin-confirmed abuse over
would-contain); detections an admin confirmed as abuse with no row give the misses. Switch to `enforce` once
precision holds over a meaningful sample.

## Reversal

Unsuspend on the user profile reverses the suspension. Revoked API keys stay revoked
and a removed positive balance is not restored, the same as a manual Contain. The bulk
Undo does not apply: it is a 30-second window for the admin who ran the action.

## Negative balances

Contain removes a positive balance and keeps a negative one. Writing the debt off would
be a credit grant (counted against the batch credit cap, audited as a grant, handed back
on unsuspend) and would erase the record of the shortfall, so the dialog copy now says
what the code does instead.

Graduated and Contain decisions retain separate ids and lifecycle metadata. Committed per-account
Contain receipts release the matching graduated holds transactionally; partial results preserve the
remaining holds and their ordinary release paths. Older cached results without account receipts keep
holds until a later explicit release or expiry.

Apply the tier-separated claim migration before enabling graduated tiers. It normalizes legacy
Contain rows, creates the replacement uniqueness guard before retiring the recognized old guards,
and preserves the existing retention and serving indexes. Missing and null claim classes share
Contain's unique slot, so pre-tier writers remain deduplicated during deployment.

Keep every graduated tier off until all upgraded callers are deployed and pre-tier worker invocations
have completed. Contain may remain enabled during this rollout. The compatible index protects
Contain insertion across versions; graduated activation follows deployment and worker drain.
