# Gears Discovery Modal - Design

## Goal

Raise engagement by periodically reminding users of features they have not tried yet.
A modal titled "Don't miss these features" shows up to 3 Gears cards for unused features,
styled exactly like the cards on the Gears page. Clicking a card takes the user straight
into the feature.

Success is measured by the new analytics events (shown / clicked / dismissed) and by
gear unlock rate among users who saw the modal.

## Show rules

The modal opens on app load when ALL of these hold:

- at least **1** unused visible gear remains (`DISCOVERY_MIN_CANDIDATES`; started at 3, lowered so the last 1-2 gears still get shown);
- at least **1 day** has passed since it was last shown (`DISCOVERY_COOLDOWN_MS`);
- the user has not chosen "Don't show again";
- What's New has not been shown in this browser session;
- no other modal dialog is visible (`isAnyModalDialogOpen()`), no chat response is streaming;
- the route is not `/admin*` or `/gears*` (the page already shows every card) and the user is signed in;
- a settle delay of ~5 s after the gears status loads has passed.

"Unused" means `!unlocked && !claimed` on the `GET /api/gears/status` entry, after the
`useVisibleGears` deployment filter. Thresholds are code constants; no admin settings.

`lastShownAt` is written when the modal actually opens, not when it becomes eligible.
Closing (X, Esc, backdrop) counts as a normal close: it may show again after the
cooldown. "Don't show again" sets a permanent flag.

## Card selection and rotation

- `DISCOVERY_PRIORITY` is a hand-ordered list of gear keys by product value. Initial order:
  `models, agents, projects, datalakes, files, research, websearch, published,
  shareproject, image, voice, video, music, sound, react, python, mementos, questmaster,
  rapidreply, mcp, slack, importopenai, importclaude, apikey, apicall, shareagent,
  forknotebook, downloadnotebook, webfetch, wolfram, matheval, mfa, hearth, clidocs`.
- Candidates = unused visible gears sorted by that list; gears missing from the list are
  appended in endpoint order, so new catalog entries are never dropped.
- Each show takes 3 candidates starting at `rotation % candidates.length`,
  wrapping around, then advances `rotation` by 3 (`DISCOVERY_MAX_CARDS`, started at 5 and lowered to 3).

## Persistence

One localStorage key per user: `gears_discovery_<userId>` holding
`{ lastShownAt: number, dismissed: boolean, rotation: number }`. Same approach as
What's New (`modalStorage` in `modalHelpers.ts`). Per-device by design; acceptable for a
1-day reminder. Malformed or missing data is treated as the empty state.

## Components

1. **`app/components/gears/GearCard.tsx`** - the card extracted from
   `app/routes/gears/index.tsx`, together with `GEAR_ICONS`, `GLYPH_VIEWBOX`,
   `RewardChip`, `ClaimButton` and the reward helpers. The Gears page switches to it with
   no visual change. Props cover what the page needs today (CTA label, claim handler,
   ref, test ids).
2. **`app/hooks/useGearCta.ts`** - the page's `onCta` (the `ctaAction` interpreter:
   `navigate:`, `external:`, `files`, `#stamp:`) moved into a hook shared by the page
   and the modal.
3. **`lib/gears/discovery.ts`** - pure logic, no React: constants,
   `DISCOVERY_PRIORITY`, `pickDiscoveryGears(gears, rotation)`,
   `shouldShowDiscovery({ state, candidateCount, now })`, and the localStorage
   read/write helpers.
4. **`app/hooks/useGearsDiscovery.ts`** - combines `useVisibleGears`, the user, streaming
   state, the What's New session flag and storage; returns
   `{ open, gears, close, dismissForever, onCardClick }`.
5. **`app/components/gears/GearsDiscoveryModal.tsx`** - Joy `Modal`: title
   "Don't miss these features", subtitle "Each one pays a one-time credit bonus the first
   time you use it.", a grid of `GearCard`s (1 / 2 / 3 columns at xs / sm / md, same as
   the Gears page; full-screen and scrollable on phones), footer links "Don't show again"
   and "See all gears" (navigates to `/gears`). Cards show the reward chip; no Claim
   button (candidates are never claimable). Card click: close modal, log event, run the
   gear's CTA. Mounted in the Notebook layout next to the existing modals.
6. **What's New session flag** - a tiny module-level flag (e.g. in
   `app/components/modals/whatsNewSession.ts`) that `ModalManager` sets when it opens
   What's New and the discovery hook reads.

## Analytics

Add to `FirstRunEvents` (`b4m-core/common/src/schemas/analytics/events/firstRun.ts`):

- `GEARS_DISCOVERY_SHOWN` - metadata: `count`, `keys` (comma-joined).
- `GEARS_DISCOVERY_CLICKED` - metadata: `key`, `position`.
- `GEARS_DISCOVERY_DISMISSED` - metadata: `how` = `close` | `never` | `see_all`.

## Error handling

- Gears status fetch fails or is pending: show nothing.
- localStorage unavailable or throws: treat as empty state on read; swallow on write
  (worst case the modal can reappear sooner).
- A gear whose CTA navigates: the modal closes first, then navigation runs.

## Testing

- Unit (`lib/gears/discovery.test.ts`): cooldown boundaries, minimum
  candidates, dismissed flag, priority ordering with unknown keys appended, rotation
  wrap-around, fewer than 5 candidates.
- RTL (`GearsDiscoveryModal.test.tsx`): renders the given cards, card click closes and
  invokes the CTA, "Don't show again" persists the flag, analytics events fire.
- Existing Gears page tests pass unchanged after the `GearCard` / `useGearCta` extraction.

## Out of scope

- Admin-configurable thresholds or priority.
- Server-side persistence of shown/dismissed state.
- Manual entry point to open the modal.
