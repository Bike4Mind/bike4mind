---
title: Bike4Mind Usage Policy
type: usage-policy
version: 1.0.0
effectiveDate: TBD
status: In force as drafted — outside-counsel review deferred to ~1,000 users/stars (see README)
mirrors:
  anthropic: https://www.anthropic.com/legal/aup
  openai: https://openai.com/policies/usage-policies/
---

# Bike4Mind Usage Policy

_This Usage Policy is part of, and incorporated into, the Bike4Mind [Terms of Service](./terms-of-service.md). It describes what you may not do with Bike4Mind. Because Bike4Mind gives you access to third-party AI models over shared infrastructure, your use is **also** governed by the providers' own policies (see §4)._

> ⚖️ **Not legal advice.** Structured to mirror the Anthropic Usage Policy and OpenAI Usage Policies. **In force as drafted for launch; outside-counsel review is deferred to the ~1,000 user/star threshold (see the legal folder README).** **§0 is a deliberate open-core divergence with no analog in the providers' policies — first on counsel's list when engaged, since a court may one day read the "door out" language.**

## 0. Why these rules exist — and the door out

Bike4Mind hosted is a shared service: most traffic routes over shared provider API keys and shared infrastructure. That gives us obligations we don't get to opt out of — the law, our providers' usage policies (which bind you transitively when you use our keys), and the duty to protect every other user on the same infrastructure. The rules below are those obligations, not our ideology.

Bike4Mind is also open core. If your work needs freedoms the shared service cannot offer — your own provider agreements, your own moderation posture, air-gapped or regulated workloads, or legitimate use cases our upstream providers' policies don't accommodate — you don't have to ask our permission: self-host it, or fork it (under the terms of the BSL 1.1 license). On your own infrastructure with your own keys or open-weight models, sections 2 and 4 of this policy simply have nothing to attach to. That is the point of the architecture.

One thing does not change when you fork: the law. Nothing in the open core is an invitation to evade section 1 — those standards are the law of the jurisdictions we and you operate in, and a fork inherits your legal obligations, not our permission.

## 1. Universal Usage Standards

You may not use Bike4Mind, or the AI models accessed through it, to:

1. **Produce or distribute illegal content** — including child sexual abuse material (CSAM) or any content that sexually exploits, endangers, or depicts minors; or any content unlawful where you are. We detect, block, and **report CSAM to NCMEC** as required by law (18 U.S.C. §2258A).
2. **Harm or endanger people** — content promoting violence, self-harm, terrorism, or the creation of weapons; harassment, threats, or targeted abuse.
3. **Deceive or defraud** — spam, phishing, scams, impersonation, disinformation, plagiarism, or academic dishonesty.
4. **Compromise security** — malware, exploits, credential stuffing, unauthorized scraping, or attacks on any system or third party.
5. **Violate privacy or rights** — collecting, exposing, or processing personal data without a lawful basis; infringing intellectual-property or publicity rights.

## 2. Shared-Platform Standards (Bike4Mind-specific)

Bike4Mind routes most traffic over shared provider API keys. To protect every user on that shared infrastructure, you may not:

1. **Evade or degrade platform controls** — probe, circumvent, or interfere with per-user attribution, rate limits, credit limits, or content moderation.
2. **Endanger the shared keys** — use the service in a way that risks the warning, throttling, or suspension of Bike4Mind's provider accounts (i.e., don't get our shared key banned).
3. **Resell or proxy** — resell, sublicense, or expose shared-key access, or use Bike4Mind to build a competing model-passthrough/proxy service.
4. **Farm accounts** — create accounts to evade limits, bans, or the credit system.

## 3. High-Risk Use Cases (heightened responsibility)

Uses that materially affect safety, rights, or livelihood — e.g. legal, medical, financial, or employment decisions — require a qualified human in the loop and clear disclosure to affected people that AI is being used. Do not present AI output as professional advice.

## 4. Provider Policies (pass-through — binding)

Your use of models through Bike4Mind is **also** governed by the applicable provider policy, and a violation of either is a violation of this Usage Policy:

- **Anthropic Usage Policy** — https://www.anthropic.com/legal/aup
- **OpenAI Usage Policies** — https://openai.com/policies/usage-policies/

## 5. Enforcement

We may throttle, suspend, or terminate accounts that violate this policy, with or without notice, and we cooperate with lawful requests. We may remove content and report unlawful activity to the appropriate authorities. Nothing here waives our right to act on abuse we detect.

## 6. Reporting

Report suspected abuse or policy violations to **abuse@bike4mind.com** _(confirm address before launch)_.
