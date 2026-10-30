# Signup, credit, pricing and plan settings inventory

Every setting that decides what a user gets and what they pay: where an admin edits it, which code reads
it, and whether changing it changes what a customer pays. Use it before moving, merging or removing one of
these settings, and keep it current when you add one.

The source of truth stays in code:

- Setting definitions: `settingsMap` and `API_SERVICE_GROUPS` in `b4m-core/common/src/schemas/settings.ts`.
- The Growth and Pricing tab layout: `GROWTH_PRICING_SECTIONS` and `GROWTH_PRICING_LINKS` in
  `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`.
- Keys hidden from Admin Settings because Growth and Pricing owns them: `GROWTH_PRICING_ONLY_KEYS` in
  `apps/client/app/components/admin/AdminSettingsTab.tsx`.

## Scope

- Every key on the Growth and Pricing tab.
- Every key in the `Credits System` group (`API_SERVICE_GROUPS.CREDITS`).
- Every key in the `API Rate Limiting` group (`API_SERVICE_GROUPS.RATE_LIMITING`).
- The settings that price compute in credits (`HardwareComputeCreditsPerUsd`, `SimulatorComputeCreditsPerRound`).
- Pricing that is not an admin setting: the model pricing catalog, credit packs, subscription plans and the
  deploy-time markup. These are listed separately, after the settings table.

Out of scope: spend brakes that cap usage without pricing it (data lake embedding budgets, the hardware
compute per-run and per-day USD caps) and settings that only toggle a feature.

## Columns

- **Admin tab**: where an admin edits the key. `Admin Settings > <section> > <group or category>` follows the
  section and group names the Admin Settings tab shows.
- **Code readers**: what reads the value at runtime, summarized. The full `git grep -lw <key>` result for each
  key is in the [appendix](#appendix-git-grep-results). Some readers go through a helper rather than naming
  the key; those helpers are named here.
- **Changes customer price**: `yes` when changing the value changes what a customer is charged, or what they
  receive for money already paid. Free grants and limits are `no` even when they change platform cost.
- **Proposed section**: where the key belongs in the five-section layout from the admin settings epic:
  Signup and starter credits / Credit pricing and conversion / Model pricing / Plans, seats and packs /
  Usage limits.

## Settings

| Key | Admin tab | Code readers | Changes customer price | Proposed section |
|---|---|---|---|---|
| `allowOpenRegistration` | Growth and Pricing > Signup and starter credits | Registration (`b4m-core/services/src/userService/register.ts`), the login and register pages through `/api/settings/serverConfigPublic`, OTP and OAuth sign-in through `isOpenRegistrationAllowed` (`apps/client/server/utils/auth/openRegistration.ts`), and the starter-credit amount (`getOpenSignupStarterCredits` in `apps/client/server/utils/starterCredits.ts`). | no. Decides who receives `defaultFreeCredits`, so it changes platform cost, not price. | Signup and starter credits |
| `defaultFreeCredits` | Growth and Pricing > Signup and starter credits | The verified-email grant (`b4m-core/services/src/userService/freeCredits.ts`, `register.ts`), the new-user welcome and plan cards (`NewUserWelcome.tsx`, `PlansSection.tsx`, `CreditsExplanation.tsx`), the publish share footer, the entitlements registry, and three backfill scripts in `packages/scripts`. | no. A free grant. | Signup and starter credits |
| `signupGrantDailyBudget` | Admin Settings > User Management > Credits System > Signup Grant Daily Budget | The daily budget reservation (`b4m-core/services/src/userService/signupGrantBudget.ts`), the flat and staged signup grants that draw it (`freeCredits.ts`, `stagedSignupGrant.ts`), and no-card unlocks, which draw it and refuse while a signup tranche is held for it (`noCardUnlock.ts`). | no. Caps how many free signup credits are paid per UTC day; overflow is held, not priced. | Signup and starter credits |
| `signupGrantActivityEnabled` | Admin Settings > User Management > Credits System > Signup Grant Activity Unlock | The activity drip gate (`isActivityDripEnabled` in `apps/client/server/credits/activityUnlock.ts`), the heartbeat (`apps/client/server/credits/recordActiveSession.ts`, `useSignupGrantHeartbeat.ts`) and the unlock copy (`SignupGrantStatus.tsx`, `NewUserWelcome.tsx`). | no. Switches the free daily drip on or off. | Signup and starter credits |
| `signupGrantActivityMinActiveSeconds` | Admin Settings > User Management > Credits System > Signup Activity Minimum Active Seconds | The server-accrued active time a UTC day needs before the drip pays (`resolveRequiredActiveSeconds` in `activityUnlock.ts`, `recordActiveSession.ts`) and the "about N minutes" unlock copy (`newUserWelcomeModel.ts`). Clamped to 60-7200, default 60. | no. Sets how long a free drip takes to earn. | Signup and starter credits |
| `signupGrantActivityDailyCredits` | Admin Settings > User Management > Credits System > Signup Activity Daily Credits | The per-day drip amount (`resolveDripLimits` in `stagedSignupGrant.ts`), the heartbeat gate and the unlock copy. Pays only from the unlock pool (`verifiedUnlockCredits`) and nothing while that is 0. | no. A free grant. | Signup and starter credits |
| `signupGrantActivityMaxCredits` | Admin Settings > User Management > Credits System > Signup Activity Maximum Credits | The lifetime per-account cap on the activity drip (`resolveDripLimits` in `stagedSignupGrant.ts`, `activityUnlock.ts`, `recordActiveSession.ts`). | no. Caps free credits. | Signup and starter credits |
| `signupGrantActivityPreviewTestMode` | Admin Settings > User Management > Credits System > Signup Drip Preview Test Mode | Preview-only five-minute earning windows in `signupDripPeriod.ts`; default off. Only `pr<number>` stages honor the switch. Production/staging keep UTC days, and the platform budget still uses real UTC days. | no. Accelerates free-grant testing only. | Signup and starter credits |
| `ReferralCreditsAmount` | **Two editors**: Growth and Pricing > Signup and starter credits, and Admin Settings > User Management > Referrals | The referred-user grant at registration (`register.ts`), the referral send route (`apps/client/pages/api/reg-invites/refer.ts`) and the "invited person gets N credits" line (`ReferralModal.tsx`). | no. A free grant. | Signup and starter credits |
| `ReferralFirstAnswerCredits` | Growth and Pricing > Referral rewards for inviters | The inviter payout when the invited friend has a first answer and a verified email (`apps/client/server/referrals/firstAnswerReward.ts`). Only friends who signed up on or after the first-value launch date (`FIRST_VALUE_LAUNCH_AT` in `apps/client/server/analytics/funnel.ts`) qualify. Default 0 (off). | no. A free grant. | Signup and starter credits |
| `ReferralFirstPaymentCredits` | Growth and Pricing > Referral rewards for inviters | Defined only; the payout reads it in a later change. Default 0 (off). | no. A free grant. | Signup and starter credits |
| `ReferralSecondPaymentCredits` | Growth and Pricing > Referral rewards for inviters | Defined only; the payout reads it in a later change. Default 0 (off). | no. A free grant. | Signup and starter credits |
| `ReferralHoldDays` | Growth and Pricing > Referral rewards for inviters | Defined only; the payout reads it in a later change. | no. A hold period. | Signup and starter credits |
| `ReferralInvitesPerUser` | Growth and Pricing > Referral rewards for inviters | The starting invite count at registration (`register.ts`). New signups only. | no. A limit. | Usage limits |
| `ReferralAlertRewardsPerDay` | Growth and Pricing > Referral rewards for inviters | The 24-hour reward-count alert in `apps/client/server/referrals/firstAnswerReward.ts`. | no. An alert threshold. | Usage limits |
| `blockDisposableEmails` | Admin Settings > User Management > Credits System | `shouldBlockDisposableEmail` (`b4m-core/services/src/userService/disposableEmail.ts`), called from registration, the email-verified grant (`apps/client/server/auth/emailVerifiedGrants.ts`) and the OAuth starting-grant backfill. | no. Stops free-credit farming. | Signup and starter credits |
| `blockedEmailDomains` | Admin Settings > User Management > Credits System | `isAdminBlockedEmailDomain` inside `shouldBlockDisposableEmail` (`b4m-core/services/src/userService/disposableEmail.ts`), so the same readers as `blockDisposableEmails`. Entries are normalized and validated on save in `apps/client/pages/api/settings/update.ts`. | no. Stops free-credit farming from domains the disposable list misses. | Signup and starter credits |
| `syntheticUserEmailDomains` | Admin Settings > User Management > Credits System | Funnel analytics (`apps/client/server/analytics/funnel.ts`), and the reserved `persona-` username check (`b4m-core/services/src/userService/reservedUsername.ts`), which lets a verified email on one of these domains choose that prefix. | no. Flags test accounts. | Signup and starter credits |
| `pricePerCredit` | Growth and Pricing > Credits and pricing | The per-credit Stripe purchase (`handlePerCreditTransaction` in `apps/client/lib/credits/utils.ts`, reached from `/api/stripe/start-payment`), the floor check on save (`apps/client/pages/api/settings/update.ts`) and `PaymentButton.tsx`. | yes, but only on the per-credit purchase path. No UI offers it today (every `PaymentButton` is a credit pack), and credit packs ignore this key. | Credit pricing and conversion |
| `enforceCredits` | Growth and Pricing > Credits and pricing | 62 files. The credit gates on every billed path: chat completion and reservation (`apps/client/server/billing/reserveRequestCredits.ts`, `creditPreflight.ts`), image, music, video and generation jobs, voice sessions, embeddings, the agent executor in `apps/workers`, and `areCreditsEnforced` in `b4m-core/services/src/billing/isOperationalBillingEnabled.ts`; plus the credit UI (balance chip, composer, billing and credits modals). Default is off on self-host (`B4M_SELF_HOST`). | yes. Off means usage is not deducted from balances. | Credit pricing and conversion |
| `billOperationalUsage` | Admin Settings > User Management > Credits System | `isOperationalBillingEnabled` and `recordOperationalUsage` (`b4m-core/services/src/billing/`), used by session preflight and lake semantic search. Lake research runs (`apps/workers/src/dataLakes/runLakeResearch.ts`) do not read it: they bill credits through `forceCreditBilling` whatever this key is set to. | yes. On also debits credits for background model and embedding spend (naming, summarization, tagging, KB search). | Credit pricing and conversion |
| `HardwareComputeCreditsPerUsd` | Admin Settings > Features > Experimental | No reader in this repository. Its default is `CREDITS_PER_USD_COST` from `b4m-core/common/src/pricing.ts`. | yes. Credits charged per $1 of compute hardware cost. | Credit pricing and conversion |
| `SimulatorComputeCreditsPerRound` | Admin Settings > Features > Experimental | No reader in this repository. | yes. Credits charged per simulator round. | Credit pricing and conversion |
| `enableTeamPlan` | Growth and Pricing > Team plan | The team checkout gate (`apps/client/pages/api/organizations/subscriptions/subscribe.ts`), the disabled-purchase message (`packages/server-utils/src/lib/subscriptions/constants.ts`), and the team UI through `useTeamPlanAvailable` (`CreateTeamModal.tsx`, `OrganizationBillingSection.tsx`, `PlansSection.tsx`, the organizations route). | no. Decides whether the Team plan is sold, not its price. | Plans, seats and packs |
| `teamPlanMinSeats` | Growth and Pricing > Team plan | `resolveTeamPlanSettings` (`b4m-core/common/src/utils/teamPlanSettings.ts`), read on the server through `getTeamPlanSettings` and `assertSeatsWithinPlan` (`packages/server-utils/src/services/teamPlanSettings.ts`): team checkout, seat updates, admin grants and conversion to paid. In the UI through `useTeamSeatLimits`. | yes. Sets the smallest team purchase, and so the minimum charge. | Plans, seats and packs |
| `teamPlanMaxSeats` | Growth and Pricing > Team plan | The same resolver and helpers as `teamPlanMinSeats`, plus admin seat changes (`apps/client/pages/api/admin/organizations/[id]/seats.ts`), the partner-signup auto-raise (`applyPartnerRuleMembership.ts`, `OrganizationModel.ts`) and the admin Organizations tab. | no. A cap on seats. | Plans, seats and packs |
| `teamPlanCreditsPerSeat` | Growth and Pricing > Team plan | The invoice credit grant (`getTeamPlanSettings` in `apps/workers/src/lib/userSubscriptions/serverUtils.ts`), admin team grants, and the Team plan card and grant modal through `useTeamCreditsPerSeat`. | yes. Sets how many credits each paid seat buys. | Plans, seats and packs |
| `lowCreditsThreshold` | Growth and Pricing > Credits and pricing | `resolveLowCreditsThreshold` (`b4m-core/common/src/utils/teamPlanSettings.ts`) through `useLowCreditsThreshold`: the credit chip, composer, billing modal and agent views. | no. A warning threshold. | Usage limits |
| `apiRateLimitFreePerMin` | Admin Settings > Security > API Rate Limiting (linked from Growth and Pricing) | `apps/client/server/utils/userRateTier.ts`, applied by the per-user rate limiter (`apps/client/server/middlewares/perUserRateLimit.ts`) on every per-user rate-limited API route (`/api/chat`, `/api/opti`, and the other routes that opt in). A Free value of 0 blocks all free-tier requests on those routes. | no. A request rate limit. | Usage limits |
| `apiRateLimitBasicPerMin` | Admin Settings > Security > API Rate Limiting (linked from Growth and Pricing) | Same as `apiRateLimitFreePerMin`. | no. A request rate limit. | Usage limits |
| `apiRateLimitProPerMin` | Admin Settings > Security > API Rate Limiting (linked from Growth and Pricing) | Same as `apiRateLimitFreePerMin`. | no. A request rate limit. | Usage limits |

## Pricing that is not an admin setting

| Item | Where it is edited | Code readers | Changes customer price | Proposed section |
|---|---|---|---|---|
| Model pricing catalog (per-model token rates and operator overrides) | Credit Analytics > Pricing (`apps/client/app/components/admin/CreditAnalysis/components/ModelPricingCatalog.tsx`, linked from Growth and Pricing). Append-only rows written through `/api/admin/model-prices`. | `modelPriceRepository` (`packages/database/src/models/billing/ModelPriceModel.ts`), read by the price catalog bootstrap, session operational preflight, voice session settlement and model discovery. | yes | Model pricing |
| Markup and sale rate (`CREDITS_PER_USD_COST`, `MIN_PRICE_PER_CREDIT_USD`) | Deploy time only: `NEXT_PUBLIC_PRICE_MARGIN` and `NEXT_PUBLIC_USD_TO_CREDITS_RATE`, resolved in `b4m-core/common/src/pricing.ts`. No admin editor. | Every usage charge; the `pricePerCredit` floor; credit pack sizes; the Growth and Pricing derived values; `apps/client/app/utils/aiSettingsUtils.ts`. | yes | Credit pricing and conversion |
| Credit packs (`CREDIT_PACKAGES`) | Code only: `apps/client/lib/credits/constants.ts`. Credits are derived from the price at `MIN_PRICE_PER_CREDIT_USD`. No admin editor. | `CreditsModal.tsx`, `CreditsSection.tsx`, `PaymentButton.tsx`, and the package purchase in `apps/client/lib/credits/utils.ts`. | yes | Plans, seats and packs |
| Subscription plans (`SUBSCRIPTION_PLANS`) | Code (`apps/client/lib/userSubscriptions/constants.ts`) plus Stripe price IDs from `NEXT_PUBLIC_STRIPE_PRICE_*` env vars. The admin Subscriptions tab shows each subscriber's plan but has no plan editor. | Plan cards and checkout, `/api/subscriptions/subscribe`, the invoice credit grant in `apps/workers/src/lib/userSubscriptions/serverUtils.ts`, admin grants and partner signup rules. | yes | Plans, seats and packs |
| Partner signup rules | Admin > Partner Signup Rules (`/api/admin/partner-signup-rules`) | `apps/client/server/entitlements/partnerRules.ts` and the partner-signup membership in `applyPartnerRuleMembership.ts`. Rule credits are added on top of `defaultFreeCredits`. | no. Free grants and plan membership. | Signup and starter credits |

## Findings

- **One key still has two editors.** `ReferralCreditsAmount` is edited on Growth and Pricing and under Admin
  Settings > User Management > Referrals. Every other key in scope has exactly one editor.
- **`pricePerCredit` prices a path no UI offers.** Only the per-credit branch of `/api/stripe/start-payment`
  reads it, and every purchase button in the app sells a credit pack. It is a candidate for the legacy-path
  cleanup in the admin settings epic.
- **Two credit prices have no reader here.** `HardwareComputeCreditsPerUsd` and `SimulatorComputeCreditsPerRound`
  are defined and editable, but nothing in this repository reads them.
- **The Credits System group mixes concerns.** `blockDisposableEmails` and `syntheticUserEmailDomains` are
  signup controls, and only `billOperationalUsage` prices anything.
- **Packs, plans and the markup have no admin view.** They are set in code or at deploy time, so an admin
  cannot see what each one sells and grants from the console.

## Updating this inventory

When you add, move or remove a setting in this area, update its row and regenerate its appendix entry:

```bash
git grep -lw <key> -- ':!*.test.ts' ':!*.test.tsx' ':!**/__tests__/**' ':!**/__test__/**' \
  ':!*.md' ':!docs-site/**' ':!apps/client/e2e/**' ':!b4m-core/common/src/schemas/settings.ts'
```

## Appendix: git grep results

The full result of the command above for each key, as of this document's last update. The admin editor
files (`AdminGrowthPricingTab.tsx`, `AdminSettingsTab.tsx`) appear because they name the keys they render.

<details><summary><code>allowOpenRegistration</code> (8 files)</summary>

- `apps/client/app/components/Register.tsx`
- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/routes/login.tsx`
- `apps/client/pages/api/settings/serverConfigPublic.ts`
- `apps/client/server/utils/auth/openRegistration.ts`
- `apps/client/server/utils/starterCredits.ts`
- `b4m-core/services/src/userService/register.ts`

</details>

<details><summary><code>defaultFreeCredits</code> (15 files)</summary>

- `apps/client/app/components/Session/NewUserWelcome.tsx`
- `apps/client/app/components/Session/newUserWelcomeModel.ts`
- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/components/subscription/CreditsExplanation.tsx`
- `apps/client/app/components/subscription/PlansSection.tsx`
- `apps/client/app/utils/shareFooter.ts`
- `apps/client/lib/entitlements/registry.ts`
- `apps/client/server/utils/starterCredits.ts`
- `b4m-core/common/src/types/entities/UserTypes.ts`
- `b4m-core/services/src/userService/freeCredits.ts`
- `b4m-core/services/src/userService/register.ts`
- `packages/scripts/backfillOAuthStartingGrant.ts`
- `packages/scripts/backfillPendingFreeCredits.ts`
- `packages/scripts/oauthStartingGrantPlan.ts`

</details>

<details><summary><code>ReferralCreditsAmount</code> (5 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/components/referrals/ReferralModal.tsx`
- `apps/client/pages/api/reg-invites/refer.ts`
- `b4m-core/services/src/userService/register.ts`

</details>

<details><summary><code>ReferralFirstAnswerCredits</code> (3 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/server/referrals/firstAnswerReward.ts`

</details>

<details><summary><code>ReferralFirstPaymentCredits</code> (2 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`

</details>

<details><summary><code>ReferralSecondPaymentCredits</code> (2 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`

</details>

<details><summary><code>ReferralHoldDays</code> (2 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`

</details>

<details><summary><code>ReferralInvitesPerUser</code> (3 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `b4m-core/services/src/userService/register.ts`

</details>

<details><summary><code>ReferralAlertRewardsPerDay</code> (3 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/server/referrals/firstAnswerReward.ts`

</details>

<details><summary><code>blockDisposableEmails</code> (1 file)</summary>

- `b4m-core/services/src/userService/disposableEmail.ts`

</details>

<details><summary><code>syntheticUserEmailDomains</code> (2 files)</summary>

- `apps/client/server/analytics/funnel.ts`
- `b4m-core/services/src/userService/reservedUsername.ts`

</details>

<details><summary><code>pricePerCredit</code> (6 files)</summary>

- `apps/client/app/components/Credits/PaymentButton.tsx`
- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/lib/credits/utils.ts`
- `apps/client/pages/api/settings/update.ts`
- `b4m-core/common/src/pricing.ts`

</details>

<details><summary><code>enforceCredits</code> (62 files)</summary>

- `apps/client/app/components/Credits/GenerationPayerNote.tsx`
- `apps/client/app/components/CreditsModal/CreditsModal.tsx`
- `apps/client/app/components/Project/Members.tsx`
- `apps/client/app/components/Session/AgentExecution/CreditCounter.tsx`
- `apps/client/app/components/Session/ConversationalVoice/ConversationalVoiceButton.tsx`
- `apps/client/app/components/Session/CreditButton.tsx`
- `apps/client/app/components/Session/CreditPayerNote.tsx`
- `apps/client/app/components/Session/MessageContent.tsx`
- `apps/client/app/components/Session/NewUserWelcome.tsx`
- `apps/client/app/components/Session/SessionBottom/SessionBottom.tsx`
- `apps/client/app/components/Session/SessionBottom/composerCreditUi.ts`
- `apps/client/app/components/Session/SessionBottom/useSendMessage.ts`
- `apps/client/app/components/Session/VoiceSessionModal/useVoiceSessionEngine.ts`
- `apps/client/app/components/Session/newUserWelcomeModel.ts`
- `apps/client/app/components/Session/useAffordableModelOffer.ts`
- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/components/inbox/Invites.tsx`
- `apps/client/app/components/layouts/Notebook/Sidenav/ProfileMenu.tsx`
- `apps/client/app/components/subscription/BillingDeepLinkModals.tsx`
- `apps/client/app/components/subscription/BillingModal.tsx`
- `apps/client/app/hooks/data/stripe.ts`
- `apps/client/app/routes/subscriptions/checkout.tsx`
- `apps/client/app/utils/validateChatInput.ts`
- `apps/client/pages/api/ai/music.ts`
- `apps/client/pages/api/ai/sound-effects.ts`
- `apps/client/pages/api/ai/test-realtime-voice.ts`
- `apps/client/pages/api/ai/voice-sessions/index.ts`
- `apps/client/pages/api/blog/generate-featured-image.ts`
- `apps/client/pages/api/v1/embeddings.ts`
- `apps/client/pages/api/v1/voice/sessions/[id]/end.ts`
- `apps/client/pages/api/v1/voice/sessions/index.ts`
- `apps/client/server/billing/meterPlatformCompletion.ts`
- `apps/client/server/billing/reserveRequestCredits.ts`
- `apps/client/server/chatCompletion/external/embedRoute.ts`
- `apps/client/server/decisions/runDecision.ts`
- `apps/client/server/generationJobs/wiring.ts`
- `apps/client/server/utils/callerModelList.ts`
- `apps/client/server/utils/creditPreflight.ts`
- `apps/client/server/utils/userRateTier.ts`
- `apps/client/server/websocket/voiceSessionEnded.ts`
- `apps/workers/src/queueHandlers/agentExecutor.billing.ts`
- `apps/workers/src/queueHandlers/agentExecutor.iterationCreditGate.ts`
- `apps/workers/src/queueHandlers/agentExecutor.ts`
- `b4m-core/services/src/billing/assertKeySpendWithinCap.ts`
- `b4m-core/services/src/billing/assertOwnerHasCredits.ts`
- `b4m-core/services/src/billing/isOperationalBillingEnabled.ts`
- `b4m-core/services/src/billing/recordOperationalUsage.ts`
- `b4m-core/services/src/cliCompletions.ts`
- `b4m-core/services/src/dataLakeResearchService/startResearchRun.ts`
- `b4m-core/services/src/generationJobs/createJob.ts`
- `b4m-core/services/src/llm/ChatCompletionInvoke.ts`
- `b4m-core/services/src/llm/ChatCompletionProcess.ts`
- `b4m-core/services/src/llm/ImageEdit.ts`
- `b4m-core/services/src/llm/ImageGeneration.ts`
- `b4m-core/services/src/llm/modelAdmission.ts`
- `b4m-core/services/src/llm/tools/ToolBuilder.ts`
- `b4m-core/services/src/musicJobs/createMusicJob.ts`
- `b4m-core/services/src/musicJobs/types.ts`
- `b4m-core/services/src/videoJobs/createVideoJob.ts`
- `b4m-core/services/src/videoJobs/types.ts`
- `b4m-core/slack/src/constants/slack-model-options.ts`

</details>

<details><summary><code>billOperationalUsage</code> (4 files)</summary>

- `apps/workers/src/dataLakes/runLakeResearch.ts` (mentions the key only in a comment)
- `b4m-core/common/src/types/entities/UsageEventTypes.ts`
- `b4m-core/services/src/billing/isOperationalBillingEnabled.ts`
- `b4m-core/services/src/billing/recordOperationalUsage.ts`

</details>

<details><summary><code>HardwareComputeCreditsPerUsd</code> (0 files)</summary>

No match outside the definition and tests.

</details>

<details><summary><code>SimulatorComputeCreditsPerRound</code> (0 files)</summary>

No match outside the definition and tests.

</details>

<details><summary><code>enableTeamPlan</code> (5 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/hooks/data/teamPlanSettings.ts`
- `apps/client/pages/api/organizations/subscriptions/subscribe.ts`
- `packages/server-utils/src/lib/subscriptions/constants.ts`

</details>

<details><summary><code>teamPlanMinSeats</code> (8 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/hooks/data/teamPlanSettings.ts`
- `packages/server-utils/src/lib/subscriptions/schema.ts`
- `apps/client/pages/api/admin/users/[userId]/grant-subscription.ts`
- `apps/client/server/services/organizationService.ts`
- `b4m-core/common/src/constants/organization.ts`
- `b4m-core/common/src/utils/teamPlanSettings.ts`

</details>

<details><summary><code>teamPlanMaxSeats</code> (16 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/components/admin/OrganizationsTab.tsx`
- `apps/client/app/hooks/data/teamPlanSettings.ts`
- `packages/server-utils/src/lib/subscriptions/schema.ts`
- `apps/client/pages/api/admin/organizations/[id]/convert-to-paid.ts`
- `apps/client/pages/api/admin/organizations/[id]/seats.ts`
- `apps/client/pages/api/admin/organizations/grant.ts`
- `apps/client/pages/api/admin/partner-signup-rules/backfill.ts`
- `apps/client/pages/api/admin/users/[userId]/grant-subscription.ts`
- `apps/client/server/services/organizationService.ts`
- `b4m-core/common/src/constants/organization.ts`
- `b4m-core/common/src/types/entities/OrganizationTypes.ts`
- `b4m-core/common/src/utils/teamPlanSettings.ts`
- `b4m-core/services/src/organizationService/applyPartnerRuleMembership.ts`
- `packages/database/src/models/infra/admin/OrganizationModel.ts`

</details>

<details><summary><code>teamPlanCreditsPerSeat</code> (5 files)</summary>

- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/hooks/data/teamPlanSettings.ts`
- `b4m-core/common/src/constants/organization.ts`
- `b4m-core/common/src/utils/teamPlanSettings.ts`

</details>

<details><summary><code>lowCreditsThreshold</code> (10 files)</summary>

- `apps/client/app/components/Agent/AgentView.tsx`
- `apps/client/app/components/AgentList/AgentsGrid.tsx`
- `apps/client/app/components/Session/CreditButton.tsx`
- `apps/client/app/components/Session/SessionBottom/SessionBottom.tsx`
- `apps/client/app/components/admin/AdminGrowthPricingTab.tsx`
- `apps/client/app/components/admin/AdminSettingsTab.tsx`
- `apps/client/app/components/subscription/BillingModal.tsx`
- `apps/client/app/constants/agentForm.ts`
- `apps/client/app/hooks/data/teamPlanSettings.ts`
- `b4m-core/common/src/utils/teamPlanSettings.ts`

</details>

<details><summary><code>apiRateLimitFreePerMin</code> (1 file)</summary>

- `apps/client/server/utils/userRateTier.ts`

</details>

<details><summary><code>apiRateLimitBasicPerMin</code> (1 file)</summary>

- `apps/client/server/utils/userRateTier.ts`

</details>

<details><summary><code>apiRateLimitProPerMin</code> (1 file)</summary>

- `apps/client/server/utils/userRateTier.ts`

</details>
