---
title: Telemetry Data Classification
description: Subscription acquisition data, consent gates, storage, and retention
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
counts its signups. The subscription webhook emits nothing; that path stays
deferred.

**These counts are self-reported, not verified.** The credited product comes from
`utm.source` in a first-party cookie, which is a claim the visitor's browser
makes. Nothing in this app or at the ingest end checks it against where the
visitor actually came from, so anyone who puts `?utm_source=<product>` on a link
they share can cause a real signup to be credited to that product. This is the
only place where a client-supplied string selects which product's record is
written; every other emit sends to a product its caller fixed. Every event
carries `metadata.attribution: 'self-reported'` so a consumer can identify and
filter it.

Treat these as a directional signal only. Do not use them for a payout, a
contractual count, or an external report without a verified attribution signal
the server observes for itself, such as a referrer correlated at landing and
signed so it cannot be forged.

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
