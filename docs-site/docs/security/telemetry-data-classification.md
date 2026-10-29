---
title: Telemetry Data Classification
description: Subscription acquisition and API-key usage data, consent gates, storage, and retention
---

# Telemetry Data Classification

## Subscription acquisition

Campaign attribution is optional analytics data. A campaign touch contains `source`
and optional `medium`, `campaign`, and `content` strings. Readers trim these fields,
limit each to 128 characters, discard other fields, and ignore touches without a
source. Values are browser-supplied claims, not verified referrals. Do not put
personal information or secrets in campaign URLs.

| Data                     | Storage                                                                                          | Lifetime                                       | Purpose                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| Session campaign         | App cookie `b4m_utm`                                                                             | 30 minutes                                     | Current landing attribution                    |
| Last campaign            | App cookie `b4m_last_touch`                                                                      | 30 days, refreshed on campaign landing         | Last touch before checkout                     |
| App first campaign       | App cookie `b4m_app_first_touch`                                                                 | 90 days, not overwritten while present         | First-touch fallback                           |
| Marketing first campaign | Parent-domain cookie `b4m-first-touch`, produced by the marketing site                           | Producer-managed; expected 90 days             | Preferred first touch                          |
| Checkout consent         | Boolean `attributionConsent` in the checkout request                                             | Request only                                   | Permit or suppress reading attribution cookies |
| Resolved consent         | App cookie `b4m_consent`, republished on every load                                              | 90 days, cleared when consent resolves unset   | Let the server read the browser's decision     |
| Purchase attribution     | Stripe subscription metadata `acq_first_*` / `acq_last_*` and MongoDB `Subscription.acquisition` | No automatic expiry configured by this feature | Record the consenting buyer's checkout touches |

The app's three campaign cookies and `b4m_consent` use `path=/` and
`SameSite=Lax`. They are JavaScript-readable and scoped to the app host. Lax,
not Strict, because an OAuth signup returns the browser through a top-level
cross-site GET from the identity provider, and Strict is withheld on exactly
that navigation: under Strict these cookies are absent on the one request that
credits a new account. None of them authorizes anything, and every server reader
treats the campaign fields as an untrusted claim. Stored subscription attribution
is linked to the subscription owner and must be treated as account-associated
analytics data, even though the campaign fields do not require an identity.

## Consent and destinations

Consent precedence is the app's stored decision, then the marketing site's shared
decision, then the region default. Only `row` auto-grants; a missing or unknown
region requires a decision. The browser publishes whatever that precedence
resolves to into `b4m_consent`, so a request handler reaches the same answer
without reading localStorage, and clears it when the answer goes back to unset. The banner is available even without third-party
tracker IDs because app attribution also requires a consent decision.

Capture waits in memory until consent is granted. Denial clears the three app
campaign cookies and any pending capture. The app does not delete the marketing
site's parent-domain cookie; conversion pixels ignore it without consent, and
checkout ignores all campaign cookies unless the request explicitly carries
`attributionConsent: true`. Older clients that omit the field can still purchase
without recording attribution. The client resolves consent when checkout is
requested, rather than using a value cached when the page mounted.

Stripe receives the accepted touches as subscription metadata. The first user
subscription invoice records them in MongoDB; renewals do not replace them.
Organization checkout and admin grants do not record these touches. Later denial
prevents future collection; it does not delete existing Stripe or MongoDB records.

Configured GA conversion events can receive source, medium, and campaign fields
through the shared consent-gated attribution reader.

## Cross-product signup reporting (self-reported)

Account creation emits a `signup` event to each Overwatch product named by the
consenting visitor's campaign touches, for products this deployment holds an
ingest key for. The host product is excluded from `signup`, because it already
receives `signup_completed` for every new account from the signup funnel.

A later payment by that account emits a `purchase` event to the host product and
to the same products:
each paid individual subscription invoice (first charge, renewal, or seat change,
from the invoice webhook) and each credit pack (from the payment-intent webhook). The
credited product comes from the touches stored on the user at signup, not from
the purchase, because a webhook has no browser and a credit-pack payment carries
no attribution. The host product's copy needs no touch, so a user with none stored
still produces it, with no campaign. Organization invoices are excluded because the
checkout user's signup source is not the organization's acquisition source.
Zero-amount invoices, refunds, disputes, and synthetic users send nothing. Each
event carries the amount collected in the currency's major unit (dollars, or whole
yen), the currency, whether it was a subscription or credits, and the invoice
billing reason. It is
keyed on the Stripe invoice or payment intent, so a redelivered webhook does not
count twice. Overwatch has no purchase stage in its funnel yet, so these events
are stored as raw events only.

The rest of an individual subscription's lifecycle, and the account's, goes to the
host product and to the same products in the same way:

- `payment_failed`: a failed subscription invoice (amount due, currency, attempt
  number, billing reason), once per attempt, or a failed credit-pack payment
  (amount, currency), once per failed confirmation.
- `subscription_ended`: from the subscription-deleted webhook, whatever ended it.
  Carries Stripe's cancellation reason, the plan name and interval, and whole days
  from the subscription's start to its end.
- `plan_changed`: the subscription moved to another price. Carries the plan names
  and intervals on each side and whether it was an upgrade, a downgrade or the same
  tier, by plan tier.
- `subscription_cancel_scheduled` and `subscription_cancel_reverted`: a period-end
  cancellation being set, or withdrawn. Carries the plan name and interval.
- `account_deleted`: an admin deleted the account. Sent after the deletion
  commits, from the account as it stood just before it, so like every event here it
  carries the user's pseudonym, and the host copy carries the stored first-touch
  campaign. Carries whether the account was a subscriber and whole days since
  signup. Deleting the account does not erase Overwatch's records keyed by that
  pseudonym, this event and the account's earlier events included.

Plans are named by plan name and interval, never by Stripe price id. Organization
subscriptions send none of these. Every copy of these events, and of `purchase`,
carries `metadata.userAction: false`, because each arrives from a webhook, a worker
or an admin rather than from the user's own request, and Overwatch would otherwise
count the user as active on that day. For the same reason, `signup_completed` and
the other signup-funnel events for an account an admin created carry it too, as do
`email_verified` and `credits_granted` when an admin verifies an account's email.
Overwatch also leaves `userAction: false` signups out of its funnel's signup count,
so an account an admin created is not counted as a signup.

Synthetic accounts (`User.isSynthetic`: test personas and accounts on a configured
test domain) are marked rather than dropped on the host's own Overwatch events: the
signup-funnel events (`signup_completed`, `email_verified`, `credits_granted`,
`first_value`) and the daily `active` event carry `metadata.lane: "synthetic"`, so
they can be told apart from real accounts. Real users' events carry no lane. The
billing and account events above, the cross-product `signup`, and the client-side GA4
and ad-pixel conversions still send nothing for a synthetic account.

Because the touches were recorded with consent at signup, a purchase is credited
from them even if the visitor later withdraws cookie consent: the webhook has no
browser to ask, and the server keeps no per-user consent state. Withdrawal stops
new touches from being recorded; it does not stop purchases being credited from
the touches already stored.

**These counts are self-reported, not verified.** The credited product comes from
`utm.source` in a first-party cookie, which is a claim the visitor's browser
makes. Nothing in this app or at the ingest end checks it against where the
visitor actually came from, so anyone who puts `?utm_source=<product>` on a link
they share can cause a real signup to be credited to that product. This is the
only place where a client-supplied string selects which product's record is
written; every other emit sends to a product its caller fixed. Every event sent
to a credited product carries `metadata.attribution: 'self-reported'` so a consumer
can identify and filter it. The host product's copies carry no such marker: the
host observed the payment or the change itself.

This stream is directional by owner decision, and it stays directional: it is
never upgraded into a verified one. Do not use these events, or any Overwatch
product funnel that counts them, for a payout, a contractual count, or an
external report, and do not give an external party access to a funnel that
includes them. A signed or first-party referral link would stop a third party
misattributing a signup, but not a credited product creating accounts through
its own genuine link. So any count that money or a contract depends on must
come from host-owned records of paid conversions instead: the subscription's
recorded acquisition touches, reconciled against Stripe.

Overwatch does not yet separate `attribution: 'self-reported'` events in its
funnel, so a product's signup stage currently mixes them with first-party
signups.

Signup attribution is gated server-side and fails closed. The gate reads
`b4m_consent` first and the marketing site's `b4m-consent-decision` second; only
an explicit `granted` permits reading the campaign cookies. Denied, absent,
empty, malformed, and unrecognised values all suppress at both levels, and a
value that is not a recognised decision falls through to the next source rather
than being read as a denial. A visitor in the opt-in region who has made no
decision is not attributed. A `row` visitor who never clicks is attributed,
because the browser resolves the region default to `granted` and publishes it,
the same answer checkout reaches.

A suppressed signup sends nothing on this stream: with no touches there is no
source product, so no event is emitted at all. The account itself is still
recorded in the application's own registration log, which is a separate system.

Reading the app cookie first brings signup close to checkout's answer for the
same visitor. A visitor who consents on the app rather than the marketing site is
attributed, where a gate on the shared cookie alone would suppress every
app-direct signup; and a visitor who declines on the app is not attributed off a
surviving parent-domain `b4m-first-touch` even when the shared cookie still says
granted.

The two can still disagree for a while. `b4m_consent` is a snapshot taken on the
last app page load, and the server honours it ahead of the shared cookie. A
visitor whose app snapshot says `granted` and who then declines on the marketing
site is still attributed by signup until the app loads again and republishes,
while checkout, which resolves consent in the browser at request time, would
already see the denial.

## Troubleshooting missing attribution

- Confirm consent was granted when checkout was requested. Cookie presence alone
  does not authorize collection, and a missing consent field fails closed.
- Confirm the landing URL included `utm_source`; other UTM fields alone do not
  create a touch. Expired, malformed, or blocked cookies produce no attribution.
- Check `acq_first_*` and `acq_last_*` on the Stripe subscription, then the first
  invoice's processing and the MongoDB subscription record.
- The admin subscription API includes acquisition, but the subscription table
  has no dedicated acquisition column.
- For a missing cross-product purchase or lifecycle event, check the user's stored
  signup acquisition, the source product's ingest key, and the billing event failure
  warning in analytics logs. Organization subscriptions emit none of them.
- For one missing from the host product, check the host's own ingest key: its copy
  needs no stored acquisition.

## API-key usage log

Every request to a `baseApi` route that authenticates with an API key writes one `ApiKeyUsageLog` row when the response finishes. Routes served through the contract router (`/api/ai/v1`) and embed-key routes (`/api/embed`) do not write rows. The `endpoint` field stores the Next.js route template (for example `/api/agents/[id]`), never the raw URL: path ids and the query string are not recorded. A query-string key never shapes the template. The `UserApiKeyEvents.USED` analytics event carries the same templated endpoint. Rows written before templating was introduced may still hold a raw URL until they expire.

| Data           | Storage                           | Lifetime            | Purpose                                          |
| -------------- | --------------------------------- | ------------------- | ------------------------------------------------ |
| Endpoint       | Route template, no query string   | 90 days (TTL index) | Per-route usage stats, scope-rollout preflight   |
| Method, status | HTTP method and response status   | 90 days (TTL index) | Usage stats, abuse and security investigation    |
| Latency        | Response time in milliseconds     | 90 days (TTL index) | Usage stats                                      |
| Client IP      | `ipAddress`, resolved server-side | 90 days (TTL index) | Abuse and security investigation, anomaly alerts |
| Key and owner  | `keyId` and `userId`              | 90 days (TTL index) | Attribute usage to a key and its owner           |

## Usage pattern signals

A scheduled job, off by default behind the `usagePatternSignalsEnabled` admin setting, derives a usage profile for recently active free-tier accounts and stores the latest result per user in the `UserUsagePatternSignals` collection. It collects no new raw data: every input already exists in `UsageEvent`, `ApiKeyUsageLog` or `UserApiKey`. The result is for admin review only and triggers no automatic action on the account, its keys or its balance. Paid accounts get a marker with no signals.

| Data              | Storage                                                                                                                   | Lifetime                                         | Purpose      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------ |
| Signals           | Per signal (API-key share, request cadence, balance polling, key-mint timing): value, triggered flag, weight, explanation | 30 days after last checked (TTL on `computedAt`) | Admin review |
| Score and outcome | `score`, `needsReview`, `skipped` reason, `computedAt`, keyed by `userId`                                                 | 30 days after last checked (TTL on `computedAt`) | Admin review |

## Signup and login network metadata

Every self-service signup stores the network it came from on the new account (`signupMeta`), written once. Every successful signup and sign-in also writes one `AuthEvent` row. Admin-created accounts and impersonation sessions write neither. The network number (ASN) and country come from headers the CDN sets; when they are absent the fields are empty, never guessed. A failed write never blocks sign-in. Both are visible only to admins, and both are deleted with the account. The full IP on `signupMeta` is kept for the same 90 days as the `AuthEvent` rows; after that the daily `signupIpRetention` job replaces it with its /24 (IPv4) or /48 (IPv6) prefix. The other `signupMeta` fields stay for the account's lifetime. Two other stores keep sign-in IPs outside this retention: `User.loginRecords[].ip` holds the full IP of the most recent sign-ins for the account's lifetime, and `UserAuthAuditLog.actorIp` keeps it for 12 months (TTL index).

| Data          | Storage                               | Lifetime                                                                               | Purpose                                             |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Client IP     | `signupMeta.ip`, `AuthEvent.ip`       | 90 days in full, then /24 or /48 prefix for the account lifetime / 90 days (TTL index) | Abuse and security investigation                    |
| User agent    | `signupMeta.userAgent`, `AuthEvent`   | Account lifetime / 90 days (TTL index)                                                 | Abuse and security investigation                    |
| Network (ASN) | `asn`, plus operator for hosting ASNs | Account lifetime / 90 days (TTL index)                                                 | Spot signups from one network or a hosting provider |
| Country       | ISO country code                      | Account lifetime / 90 days (TTL index)                                                 | Abuse and security investigation                    |
| Hosting flag  | `isDatacenter`                        | Account lifetime / 90 days (TTL index)                                                 | Flag signups from cloud and hosting networks        |

`signupMeta.challengeVerified` records `true` only after a real server-verified challenge pass; skipped or unavailable checks remain null or absent. It shares the other non-IP signup metadata's admin-only access, account lifetime, and account-deletion behavior. Signed signup tokens carry this observation only to preserve it through verification; public test secrets and fail-open checks do not establish proof.

Signup grant assessments also emit one of the `signup-grant-assessed-full`, `signup-grant-assessed-reduced`, or `signup-grant-assessed-review` log markers after commit. These markers contain only the outcome band, without account identifiers, policy weights, network observations, or challenge tokens. CloudWatch metric filters count them for monitoring and an optional review-volume alarm. The markers follow the server log group's retention; metric counts follow CloudWatch retention. Emission is best effort, so counts are operational monitoring rather than an exact grant ledger.

## Chat turn timing

Each chat reply records where its wall-clock time went, so a slow or retried reply can be diagnosed from the reply itself. The record holds durations, counts and provider metadata only: no prompt or reply text. It is shown in the reply's Answer diagnosis panel, and a short summary with a copyable turn ID appears under replies that retried, switched model or took a minute or more.

| Data           | Storage                                                                                         | Lifetime             | Purpose                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| Durations      | `turnTiming` on the reply: queue, context build, concurrency wait and total, in ms              | Lives with the reply | Find which phase made a reply slow                                           |
| Retries        | `turnTiming.retries`: reason, HTTP status, Retry-After, provider request id, delay, model, time | Lives with the reply | Tell provider load from stalls; cite a provider request id in a support case |
| Model switches | `turnTiming.fallbackHops`: a count                                                              | Lives with the reply | Show that a reply moved to a fallback model                                  |
| Retry metric   | CloudWatch metric `ChatRetry`, dimensioned by stage, reason and model; no user or reply id      | CloudWatch retention | Retry rate by cause and model                                                |

The record also ships to clients: on the live reply frames and in the `GET /api/v1/quests/{id}` poll body. It is not redacted for people a session is shared with, matching the session message API they can already call, which returns the same fields: the record carries no prompt or reply text, and the model and provider request ids appear there too.

## Integrations gallery usage

The `/integrations` page records first-party `IntegrationsEvents` through the existing `/api/analytics/log-event` route. They are stored like every other counter event (`CounterLog` and the per-user `UserActivityCounter`), tied to the signed-in user, and sent to no third party. Like the rest of first-party usage analytics, they are not behind the attribution consent banner.

| Event                         | Metadata                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Integrations Page Viewed      | `entryPoint`: `profile_menu`, `profile_tab_link` or `direct`                                  |
| Integrations Search Performed | `query` (or `redacted`), `resultCount`, `tab`; sent once the query settles, not per keystroke |
| Integrations Filter Changed   | `filter` (`category`, `status` or `kind`) and the chosen `value`                              |
| Integrations Card Opened      | `integrationId`                                                                               |
| Integrations Connect Clicked  | `integrationId`                                                                               |
| Integrations Request Toggled  | `integrationId`, `requested`                                                                  |

The search query is free text, so it is trimmed, lowercased and capped at 64 characters before it is sent. A query containing an `@` is most likely an email address typed into the wrong box, so its text is never sent: the event carries `redacted: true` with the result count and tab instead. The entry point is named `entryPoint`, not `source`, because counter reports read `metadata.source` as the client a request came from.

Integration requests themselves ("request this integration") are product data, not telemetry. Signed-in users see only per-integration counts and their own requests. Requester identity (name, email, organization) is readable only by admins, through `/api/admin/integrations/demand/*`, and an account's requests are removed when the account is deleted.

## Bike4Mind Desktop activity to Fleet

Bike4Mind Desktop can send aggregate activity to a team's Fleet. It sends nothing until two things are true: Fleet's installer has written `~/.claude/fleet/bike4mind-desktop.json` on the machine (mode 0600; Desktop ignores a copy other users can read), and the user has turned on "Share activity with Fleet" in Desktop's Profile. Turning the switch off deletes everything not yet sent. Desktop posts OTLP/HTTP JSON logs to the Fleet origin in that file, at `/v1/logs`, from the main process, with the team telemetry key the file holds. The key never reaches the renderer and is never logged.

| Data       | Sent as                                                                                                                                    | Purpose                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Who        | `user.email` and `fleet.install.id`, from the installer file                                                                               | Attribute activity to a person in Fleet      |
| App        | `service.name` `bike4mind-desktop`, `service.version`                                                                                      | Tell Desktop apart from other tools          |
| Reply      | `bike4mind_desktop.session`: event id, conversation id, duration in ms                                                                     | Replies and active time per person and day   |
| Usage      | On the reply record: `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `credits_milli` (credits x 1000) | Which models a person uses and what they use |
| Tool call  | `bike4mind_desktop.tool`: the above plus a category only                                                                                   | Tool use by category                         |
| Repository | `bike4mind_desktop.repository`: owner/name from the `origin` remote, `view` or `edit`                                                      | Which repositories a person works in         |

The model id is the one the conversation is set to, for example `claude-opus-5`. Token counts and credits are the server's own figures for that reply, as the reply shows them. A reply that was resumed reports only what was added since the earlier part. A reply record names one model, so what the `explore` sub-agent spends is counted under the conversation's own model rather than the one that sub-agent ran on. None of it is message content.

The tool category is one of `shell`, `editor`, `browser`, `mcp`, `agent` or `other`; a tool's name, its input and its output are never sent. Messages, prompts, model output, file contents, commands and paths are never sent. Unsent events wait in `fleet-activity-queue.json` (mode 0600) under the app's data folder and keep their event ids, so a retried batch is counted once.

Repository identity uses the last two components of a supported network remote. The host and any earlier namespace components are omitted: a GitLab `group/subgroup/project` is reported as `subgroup/project`, and matching owner/name pairs on different hosts are combined. This is an activity label, not a globally unique repository identifier.

## Model availability monitoring

Hosted model monitoring publishes aggregate counts to CloudWatch. The
`UnavailableModelReferences` count covers unavailable configured model pins and
fallback references. `LifecycleSuggestions` counts unresolved operator review
items, and `LifecycleDateChanges` counts lifecycle date changes observed by model
discovery. The metrics use deployment stage and runtime host dimensions; they
contain no user, session, prompt, reply, or provider credential fields.

Diagnostic logs identify the affected model, its configuration reference path or
fallback surface, and the availability problem. Audit failures record an error
message. You use these records to identify broken model references and review
lifecycle changes. Metrics follow CloudWatch retention, and logs follow the
deployment's configured log retention. This operational monitoring does not send
product usage events to third-party analytics services.
