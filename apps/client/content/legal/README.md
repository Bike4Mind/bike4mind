# Bike4Mind Legal Agreement Set

Authoritative, **versioned** source-of-truth for the agreements a user accepts at signup. Deliberately shaped to **mirror Anthropic's and OpenAI's** document taxonomy and section structure, so we can (a) draft off their legal decisions clause-by-clause, (b) diff against their docs when they update, and (c) A/B test agreement copy/UX without changing the underlying taxonomy.

> ⚖️ **Not legal advice.** Every document here is written in-house to mirror the providers' public policies. See **Legal review posture** below for the deliberate decision on when outside counsel engages.

## Legal review posture (decision — 2026-07-02)

These agreements go **into force as drafted** to gate the public launch. Formal outside-counsel review (Gravelle, ~$1,000/hr) is **deliberately deferred until Bike4Mind passes ~1,000 users or GitHub stars** — the point where the exposure justifies the spend. Until then the docs are maintained in-house against the Anthropic/OpenAI precedent they mirror. When counsel engages, the first items on the list are **§0 of the Usage Policy (the "door out")** and the **never-train clause in ToS §5** — the two clauses a court is most likely to read someday.

---

## The document set (mirrors the providers)

| Bike4Mind doc | Version | Mirrors — Anthropic | Mirrors — OpenAI |
|---|---|---|---|
| [`terms-of-service.md`](./terms-of-service.md) | `1.0.0` (draft) | [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) | [Terms of Use](https://openai.com/policies/terms-of-use/) |
| [`usage-policy.md`](./usage-policy.md) | `1.0.0` (draft) | [Usage Policy](https://www.anthropic.com/legal/aup) | [Usage Policies](https://openai.com/policies/usage-policies/) |
| Privacy Policy — *separate track* | — | [Privacy Policy](https://www.anthropic.com/legal/privacy) | [Privacy Policy](https://openai.com/policies/privacy-policy/) |

**Privacy** currently lives at `apps/client/content/privacy.mdx` (a JSX component, unversioned). It is a **separate workstream** (data-handling / GDPR) and should graduate into this folder as `privacy-policy.md` on the same versioned format in a follow-up. It is *linked* from the ToS but is **not** part of the P0-B signup acceptance gate (which is ToS + Usage Policy).

**One intentional divergence from the mirrored shape:** `usage-policy.md` **§0 — "Why these rules exist — and the door out"** has no analog in the providers' policies. It's the open-core differentiator: because B4M is a *neutral runtime*, self-hosting or forking (per BSL 1.1) dissolves the shared-infrastructure (§2) and provider-pass-through (§4) rings — they were physics of a shared service, never ideology — while the law (§1) follows you regardless. No lab or hyperscaler can put an exit door in its own AUP; we can. Flag §0 for counsel alongside the covenant, and once blessed it belongs on `/open` as a trust signal.

This folder **supersedes** `apps/client/content/terms.mdx` — that copy is unversioned and states "minors require parental consent," which contradicts the ratified **18+** decision (see `docs/security/open-core-abuse-threat-model/p0b-aup-age-gate-decisions.md`, D1). Retire it when this set is wired in.

---

## Versioning scheme

- Each doc carries a **semver** and an **effective date** in its frontmatter (`version`, `effectiveDate`, `status`).
- At acceptance the app persists `{ type, version, acceptedAt (UTC), ip }` on the user (see the wiring spec below).
- **Re-acceptance** is prompted only on a **major** version bump (material change). Minor/patch edits (typos, clarifications) do not force re-acceptance.

## "Draft off theirs" workflow (legal + A/B space)

Because our section skeletons mirror the providers':
- **Legal** can map each of our clauses to the corresponding Anthropic/OpenAI clause and lean on their precedent, then localize.
- When a provider updates its policy, diff their doc against ours section-by-section and open a version bump.
- **A/B testing** happens at the *presentation* layer (signup copy, single-vs-split checkbox, layout) — the accepted document + version is unchanged, so experiments never fork the legal record.

## Wiring spec (the follow-up engineering pass)

The signup gate accepts `terms-of-service@<v>` + `usage-policy@<v>` and records the 18+ attestation. Enforcement must cover **every** account-creation path (password + OAuth/SSO), since access is open self-serve. Full data model + enforcement points: `docs/security/open-core-abuse-threat-model/p0b-aup-age-gate-decisions.md` → *Implementation spec*.
