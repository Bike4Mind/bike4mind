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
ingest key for. The host product is excluded, because its own funnel already
counts its signups.

A later payment by that account emits a `purchase` event to the same products:
each paid individual subscription invoice (first charge, renewal, or seat change,
from the invoice webhook) and each credit pack (from the payment-intent webhook). The
credited product comes from the touches stored on the user at signup, not from
the purchase, because a webhook has no browser and a credit-pack payment carries
no attribution. Organization invoices are excluded because the checkout user's
signup source is not the organization's acquisition source. Zero-amount invoices,
refunds, disputes, and synthetic users send nothing. Each event carries the amount
collected in major units, the currency, whether it was a subscription or credits,
and the invoice billing reason. It is
keyed on the Stripe invoice or payment intent, so a redelivered webhook does not
count twice. Overwatch has no purchase stage in its funnel yet, so these events
are stored as raw events only.

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
written; every other emit sends to a product its caller fixed. Every event
carries `metadata.attribution: 'self-reported'` so a consumer can identify and
filter it.

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
- For a missing cross-product purchase, check the user's stored signup acquisition,
  the source product's ingest key, and the purchase failure warning in analytics logs.
  Organization invoices do not emit cross-product purchases.

## API-key usage log

Every request to a `baseApi` route that authenticates with an API key writes one `ApiKeyUsageLog` row when the response finishes. Routes served through the contract router (`/api/ai/v1`) and embed-key routes (`/api/embed`) do not write rows. The `endpoint` field stores the Next.js route template (for example `/api/agents/[id]`), never the raw URL: path ids and the query string are not recorded. A query-string key never shapes the template. The `UserApiKeyEvents.USED` analytics event carries the same templated endpoint. Rows written before templating was introduced may still hold a raw URL until they expire.

| Data           | Storage                           | Lifetime            | Purpose                                          |
| -------------- | --------------------------------- | ------------------- | ------------------------------------------------ |
| Endpoint       | Route template, no query string   | 90 days (TTL index) | Per-route usage stats, scope-rollout preflight   |
| Method, status | HTTP method and response status   | 90 days (TTL index) | Usage stats, abuse and security investigation    |
| Latency        | Response time in milliseconds     | 90 days (TTL index) | Usage stats                                      |
| Client IP      | `ipAddress`, resolved server-side | 90 days (TTL index) | Abuse and security investigation, anomaly alerts |
| Key and owner  | `keyId` and `userId`              | 90 days (TTL index) | Attribute usage to a key and its owner           |

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

| Data       | Sent as                                                                               | Purpose                                    |
| ---------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| Who        | `user.email` and `fleet.install.id`, from the installer file                          | Attribute activity to a person in Fleet    |
| App        | `service.name` `bike4mind-desktop`, `service.version`                                 | Tell Desktop apart from other tools        |
| Reply      | `bike4mind_desktop.session`: event id, conversation id, duration in ms                | Replies and active time per person and day |
| Tool call  | `bike4mind_desktop.tool`: the above plus a category only                              | Tool use by category                       |
| Repository | `bike4mind_desktop.repository`: owner/name from the `origin` remote, `view` or `edit` | Which repositories a person works in       |

The tool category is one of `shell`, `editor`, `browser`, `mcp`, `agent` or `other`; a tool's name, its input and its output are never sent. Messages, prompts, model output, file contents, commands and paths are never sent. Unsent events wait in `fleet-activity-queue.json` (mode 0600) under the app's data folder and keep their event ids, so a retried batch is counted once.
