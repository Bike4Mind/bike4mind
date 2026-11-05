# Automated containment

Turns an abuse assessment's verdict into the same Contain an admin would run from the
users list (suspend, remove a positive balance, revoke API keys, end sessions, optionally
block owned email domains). It runs as the `auto-containment` system actor, and its audit
reason cites the assessment and the evidence.

## Pieces

| File | Role |
|------|------|
| `policy.ts` | Pure decision: `decideContainment(assessment, detection, config)` -> contain or skip-with-reason. |
| `executor.ts` | `applyAutoContainment`: config, idempotent decision record, hourly cap, then shadow or enforce. |
| `strongLink.ts` | On signup, a new account whose signup IP matches a blocked account within the window gets a `signupIpLinkedToBlocked` detection, assessed and decided at once. |
| `../abuseAssessment/linkedAccountEvidence.ts` | The `groupEvidence` producer the assessment sees (linked accounts, landing notebook, settlement over hold, signup method and network). |

## Decision API

The judgment is the existing abuse assessment (`executeDecision` against the Decisions
API, model pinned in `abuseAssessmentConfig`, e.g. a Jev release). It keeps its budget,
call cap and per-(detection, evidence, policy, model) cache. This module only reads its
verdict, so the assessment stays advisory everywhere else.

## Gates (setting `autoContainmentConfig`)

| Field | Default | Why |
|-------|---------|-----|
| `mode` | `shadow` | `off` / `shadow` (record only) / `enforce`. |
| `minConfidence` | 0.9 | Only near-certain `abuse` verdicts act. |
| `maxPerHour` | 5 | Fixed one-hour window, counted in shadow too so shadow measures the real cap; over it the decision is recorded as `capped` for an admin. |
| `maxAccountsPerDetection` | 5 | A larger cohort always goes to an admin. |
| `blockEmailDomains` | false | Owned domains only; public mailbox providers are never blocked. |
| `strongLinkWindowHours` | 72 | 0 turns the signup rule off. |

Only detections whose `wouldAction` is contain or suspend, with no admin verdict yet, are
eligible. Each detection is decided once (unique `detectionId` in `AutoContainmentDecision`),
and the bulk call carries `auto-containment:<detectionId>` as its idempotency key.

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
