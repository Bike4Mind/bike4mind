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
| Purchase attribution     | Stripe subscription metadata `acq_first_*` / `acq_last_*` and MongoDB `Subscription.acquisition` | No automatic expiry configured by this feature | Record the consenting buyer's checkout touches |

The app's three campaign cookies use `path=/` and `SameSite=Strict`. They are
JavaScript-readable and scoped to the app host. Stored subscription attribution
is linked to the subscription owner and must be treated as account-associated
analytics data, even though the campaign fields do not require an identity.

## Consent and destinations

Consent precedence is the app's stored decision, then the marketing site's shared
decision, then the region default. Only `row` auto-grants; a missing or unknown
region requires a decision. The banner is available even without third-party
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
through the shared consent-gated attribution reader. The subscription webhook
does not emit events into products selected by a browser's `utm_source`. Such
reporting needs verified attribution or a separately defined reporting stream.

## Troubleshooting missing attribution

- Confirm consent was granted when checkout was requested. Cookie presence alone
  does not authorize collection, and a missing consent field fails closed.
- Confirm the landing URL included `utm_source`; other UTM fields alone do not
  create a touch. Expired, malformed, or blocked cookies produce no attribution.
- Check `acq_first_*` and `acq_last_*` on the Stripe subscription, then the first
  invoice's processing and the MongoDB subscription record.
- The admin subscription API includes acquisition, but the subscription table
  has no dedicated acquisition column.
