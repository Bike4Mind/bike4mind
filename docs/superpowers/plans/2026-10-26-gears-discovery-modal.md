# Gears Discovery Modal Implementation Plan

> **Historical:** the numbers below (account age gate, 3-day cooldown, 3-5 cards) were superseded during implementation. The shipped rules are a 1-day cooldown, no account-age gate, 1 to 3 cards; the spec is authoritative.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A modal titled "Don't miss these features" that periodically shows a user 3-5 Gears cards for features they have not used yet, in the Gears page's card style, each card taking the user straight into the feature.

**Architecture:** The Gears page card is extracted into shared components (`components/gears/*`) and its CTA interpreter into a hook (`useGearCta`), with no visual change to the page. Pure selection/eligibility/storage logic lives in `lib/gears/discovery.ts`. A hook (`useGearsDiscovery`) decides once per page load whether to open, and a presentational modal plus a thin container are mounted in the Notebook layout.

**Tech Stack:** React 18, MUI Joy, TanStack Router + Query, zustand stores, Vitest + Testing Library (jsdom project), localStorage.

**Spec:** `docs/superpowers/specs/2026-10-26-gears-discovery-modal-design.md`

## Global Constraints

- Account older than **2 days**; cooldown **3 days** between shows; at least **3** candidates; at most **5** cards; settle delay **~5 s** after the gears status loads.
- "Unused" = `!unlocked && !claimed`, after the `useVisibleGears` deployment filter.
- Rotation: each show starts at `rotation % candidates.length`, wraps, then `rotation += 5`.
- Persistence: localStorage key `gears_discovery_<userId>` = `{ lastShownAt: number, dismissed: boolean, rotation: number }`; `lastShownAt` written when the modal opens.
- Never open alongside another visible dialog, during streaming, on `/admin*`, on `/gears*`, or in a page load where What's New was shown.
- Copy: title `Don't miss these features`; subtitle `Each one pays a one-time credit bonus the first time you use it.`; footer `Don't show again`, `See all gears`.
- Card click: close modal, log event, run the gear's CTA. Cards show the reward chip, never a Claim button.
- Analytics: `GEARS_DISCOVERY_SHOWN` {count, keys}, `GEARS_DISCOVERY_CLICKED` {key, position}, `GEARS_DISCOVERY_DISMISSED` {how: close|never|see_all}.
- Repo rules (root `CLAUDE.md`): ASCII only in added `.ts`/`.tsx` lines (use `&rarr;` / `'\u2014'` escapes); `data-testid` selectors named `component-action-element`; Joy tests wrapped in `CssVarsProvider` with `getThemeConfig()`; tests co-located; comments only for a non-obvious why; no ticket numbers anywhere.
- Gears page must look and behave exactly as before; its existing test file passes unchanged.

## Review Focus

1. **Another dialog or What's New in the same page load** - the user must never see two modals stacked; discovery waits while a dialog is visible and gives up for the load if What's New was shown. Pinned in Task 5 tests.
2. **Card whose CTA opens a drawer (`files`) or a new tab (`external:`)** - the discovery modal must already be closed so the drawer is not trapped under its backdrop. Pinned in Task 5 (close-before-CTA order) and Task 6 (modal closes on select).
3. **Corrupt, foreign or throwing localStorage** (manual edits, an older shape, Safari private mode) - must not crash; treated as the empty state, writes swallowed. Pinned in Task 3 tests.
4. **Clock skew: `lastShownAt` in the future** - must not suppress the modal indefinitely; a future timestamp is treated as never shown. Pinned in Task 3 tests.
5. **Status still loading, failed, or user not loaded yet** - nothing shown and nothing written to storage (a write would burn the 3-day cooldown with no modal). Pinned in Task 5 tests.

Test command used below: `pnpm --filter @bike4mind/client exec vitest run <path>` (run from the repo root; paths are relative to `apps/client`).

---

### Task 0: Environment

**Files:** none.

- [ ] **Step 1: Install and build core packages** (main moved ~690 commits; `b4m-core/common/dist` predates it)

Run: `pnpm install && pnpm turbo:core:build`
Expected: both finish without errors.

- [ ] **Step 2: Baseline the Gears page test**

Run: `pnpm --filter @bike4mind/client exec vitest run app/routes/gears/index.test.tsx`
Expected: PASS. If it fails on a clean main, stop and report.

---

### Task 1: Extract the Gears card into shared components

Pure move. The page keeps its behaviour; `app/routes/gears/index.test.tsx` is the regression gate and is not edited.

**Files:**
- Create: `apps/client/app/components/gears/gearIcons.tsx`
- Create: `apps/client/app/components/gears/gearReward.tsx`
- Create: `apps/client/app/components/gears/GearCard.tsx`
- Modify: `apps/client/app/routes/gears/index.tsx` (remove lines 80-400 helpers and the inline `<Card>` in `renderCards`, import from the new files)

**Interfaces:**
- Produces:
  - `gearIcons.tsx`: `export const GearIcon: (props: { gearKey: GearKey }) => JSX.Element`
  - `gearReward.tsx`: `export type RewardState = 'locked' | 'claimable' | 'pending' | 'claimed' | 'none'`; `export const creditText: (gear: GearStatus) => string`; `export const rewardState: (gear: GearStatus) => RewardState`; `export const RewardChip` (props `{ gear; reward; onClaim: () => void; labeled?: boolean }`); `export const ClaimButton` (props `{ gear; onClaim; mt?; testId?; compact? }`)
  - `GearCard.tsx`: `export const GearCard` with props
    ```ts
    interface GearCardProps {
      gear: GearStatus;
      /** Bottom line of the card, e.g. the gear's CTA or "Learn more". */
      ctaLabel: string;
      onActivate: () => void;
      /** Without it the card never offers a claim (the discovery modal's cards are never claimable). */
      onClaim?: () => void;
      cardRef?: (el: HTMLDivElement | null) => void;
    }
    ```

- [ ] **Step 1: Create `gearIcons.tsx`**

Move verbatim from `app/routes/gears/index.tsx`: the 34 icon imports (lines 18-51 minus `CheckIcon`, plus `SettingsOutlinedIcon`), the `DataLakeIcon` import, `GEAR_ICONS` (lines 80-115), the glyph doc comment, `ICON_SLOT`, `ICON_BOX`, `GLYPH_VIEWBOX` (lines 361-400). Add at the bottom:

```tsx
import { Box } from '@mui/joy';
import { cloneElement } from 'react';
import type { GearKey } from '@client/app/hooks/useGearsStatus';

export const GearIcon = ({ gearKey }: { gearKey: GearKey }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: `${ICON_SLOT}px`,
      height: `${ICON_SLOT}px`,
      flexShrink: 0,
      // Tertiary because an icon at title strength competes with the
      // title beside it, thirty times over.
      color: 'text.tertiary',
      '& > svg': { fontSize: `${ICON_BOX}px` },
    }}
  >
    {cloneElement(GEAR_ICONS[gearKey] ?? <SettingsOutlinedIcon />, {
      viewBox: GLYPH_VIEWBOX[gearKey] ?? '2 2 20 20',
    })}
  </Box>
);
```

(Imports go at the top of the file with the others; only `GearIcon` is exported.)

- [ ] **Step 2: Create `gearReward.tsx`**

Move verbatim from `app/routes/gears/index.tsx`: `creditText` (line 118), `RewardState` + `rewardState` (lines 120-133), `RewardChip` with its doc comment (lines 135-296), `ClaimButton` with its doc comment (lines 291-358). Add `export` to `creditText`, `RewardState`, `rewardState`, `RewardChip`, `ClaimButton`. Imports needed:

```tsx
import { Chip, chipClasses, Tooltip, Typography } from '@mui/joy';
import CheckIcon from '@mui/icons-material/Check';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { neutralFrame, rewardGreen } from '@client/app/components/common/gearRewardStyles';
import CreditIcon from '@client/app/components/svgs/icons/CreditIcon';
import { grayAlpha } from '@client/app/utils/themes/colors';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
```

In `RewardChip`'s comment `(see renderPanel)`, change to `(see the Gears page's renderPanel)` since it now lives elsewhere.

- [ ] **Step 3: Create `GearCard.tsx`**

```tsx
import { Box, Card, Divider, Stack, Typography } from '@mui/joy';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { gray } from '@client/app/utils/themes/colors';
import { GearIcon } from './gearIcons';
import { ClaimButton, creditText, RewardChip, rewardState } from './gearReward';

interface GearCardProps {
  gear: GearStatus;
  /** Bottom line of the card, e.g. the gear's CTA or "Learn more". */
  ctaLabel: string;
  onActivate: () => void;
  /** Without it the card never offers a claim (the discovery modal's cards are never claimable). */
  onClaim?: () => void;
  cardRef?: (el: HTMLDivElement | null) => void;
}

const noop = () => undefined;

/** A Gears card, shared by the Gears page and the discovery modal. */
export const GearCard = ({ gear, ctaLabel, onActivate, onClaim, cardRef }: GearCardProps) => {
  const reward = rewardState(gear);
  const claimButton = onClaim && reward === 'claimable' && <ClaimButton gear={gear} onClaim={onClaim} />;
  return (
    // <-- paste here, verbatim, the two explanatory comments that sit above <Card> in renderCards
    <Card
      ref={cardRef}
      variant="outlined"
      data-testid={`gear-card-${gear.key}`}
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      sx={/* the whole sx arrow function from the page's <Card>, verbatim, comments included */}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Stack direction="row" alignItems="center" gap={1}>
          <GearIcon gearKey={gear.key} />
          <Typography level="title-md">{gear.title}</Typography>
        </Stack>
        <RewardChip gear={gear} reward={reward} onClaim={onClaim ?? noop} />
      </Stack>
      {/* from here to </Card>: the intro Typography, the pending note, the CTA Typography
          and the claimButton footer, verbatim from the page, with ONE change:
          `{opensDetail ? 'Learn more' : gear.cta}` becomes `{ctaLabel}` */}
    </Card>
  );
};
```

The two `/* ... */` markers above are copy instructions, not code to keep: replace them with the page's exact JSX/sx so styling stays byte-identical. Remove the `GEAR_ICONS holds bare elements` comment (it now describes `GearIcon` and is redundant there). `creditText` is used by the pending note.

- [ ] **Step 4: Switch the page to the shared components**

In `app/routes/gears/index.tsx`:
- Delete the moved code (icon imports, `GEAR_ICONS`, `creditText`, `RewardState`, `rewardState`, `RewardChip`, `ClaimButton`, glyph constants) and unused imports (`Card`, `Chip`, `chipClasses`, `Divider`, `Stack`, `Tooltip`, `cloneElement`, `CheckIcon`, `CreditIcon`, `gray`, `grayAlpha`, `neutralFrame`, `DataLakeIcon`, all `@mui/icons-material/*`). Keep `rewardGreen` (tab badge) and `Button` (detail CTA).
- Add:
  ```tsx
  import { GearCard } from '@client/app/components/gears/GearCard';
  import { ClaimButton, creditText, RewardChip, rewardState } from '@client/app/components/gears/gearReward';
  ```
- Replace the `cards.map(gear => { ... })` body in `renderCards` with:
  ```tsx
  {cards.map(gear => (
    <GearCard
      key={gear.key}
      gear={gear}
      ctaLabel={opensDetail ? 'Learn more' : gear.cta}
      onActivate={() => act(gear)}
      onClaim={() => claim(gear)}
      cardRef={el => {
        if (el) cardRefs.current.set(gear.key, el);
        else cardRefs.current.delete(gear.key);
      }}
    />
  ))}
  ```

- [ ] **Step 5: Run the page test (regression gate)**

Run: `pnpm --filter @bike4mind/client exec vitest run app/routes/gears/index.test.tsx`
Expected: PASS, same test count as Task 0 Step 2. The test file must not have been edited.

- [ ] **Step 6: Typecheck and lint the touched files**

Run: `cd apps/client && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "app/(components/gears|routes/gears)" ; npx eslint app/components/gears app/routes/gears`
Expected: no output from the grep; eslint clean.

- [ ] **Step 7: Commit**

```
refactor(gears): extract the gears card into shared components
```

---

### Task 2: Extract the CTA interpreter into `useGearCta`

**Files:**
- Create: `apps/client/app/hooks/useGearCta.ts`
- Create: `apps/client/app/hooks/useGearCta.test.ts`
- Modify: `apps/client/app/routes/gears/index.tsx` (`onCta` block)

**Interfaces:**
- Produces: `export function useGearCta(onStamped?: () => void): (gear: Pick<GearStatus, 'ctaAction'>) => void`

- [ ] **Step 1: Write the failing test** `app/hooks/useGearCta.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  setOpen: vi.fn(),
  post: vi.fn(),
  openInNewTab: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => h.navigate }));
vi.mock('@client/app/components/Files/Browser', () => ({ useFileBrowser: () => ({ setOpen: h.setOpen }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));
vi.mock('@client/app/utils/externalLinks', () => ({ openInNewTab: h.openInNewTab }));

import { useGearCta } from './useGearCta';

beforeEach(() => {
  vi.clearAllMocks();
  h.post.mockResolvedValue({});
});

describe('useGearCta', () => {
  it('navigates with the query string split into search params', () => {
    const { result } = renderHook(() => useGearCta());
    result.current({ ctaAction: 'navigate:/profile?tab=published' });
    expect(h.navigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'published' } });
  });

  it('opens the file browser for files', () => {
    const { result } = renderHook(() => useGearCta());
    result.current({ ctaAction: 'files' });
    expect(h.setOpen).toHaveBeenCalledWith(true);
  });

  it('opens external links and posts the stamp, then calls onStamped', async () => {
    const onStamped = vi.fn();
    const { result } = renderHook(() => useGearCta(onStamped));
    result.current({ ctaAction: 'external:https://docs.example.com#stamp:clidocs' });
    expect(h.openInNewTab).toHaveBeenCalledWith('https://docs.example.com');
    expect(h.post).toHaveBeenCalledWith('/api/gears/stamp', { key: 'clidocs' });
    await vi.waitFor(() => expect(onStamped).toHaveBeenCalled());
  });

  it('swallows a failed stamp', async () => {
    h.post.mockRejectedValue(new Error('nope'));
    const onStamped = vi.fn();
    const { result } = renderHook(() => useGearCta(onStamped));
    expect(() => result.current({ ctaAction: 'files#stamp:clidocs' })).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(onStamped).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `pnpm --filter @bike4mind/client exec vitest run app/hooks/useGearCta.test.ts`
Expected: FAIL - cannot resolve `./useGearCta`.

- [ ] **Step 3: Implement** `app/hooks/useGearCta.ts`

```ts
import { useNavigate } from '@tanstack/react-router';
import { api } from '@client/app/contexts/ApiContext';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import { openInNewTab } from '@client/app/utils/externalLinks';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';

/** Runs a gear's ctaAction - see lib/gears/presentation.ts for the grammar. */
export function useGearCta(onStamped?: () => void) {
  const navigate = useNavigate();
  const { setOpen: setFileBrowserOpen } = useFileBrowser();

  return (gear: Pick<GearStatus, 'ctaAction'>) => {
    const [action, stampDirective] = gear.ctaAction.split('#');
    const stampKey = stampDirective?.startsWith('stamp:') ? stampDirective.slice('stamp:'.length) : null;
    const claimStamp = () => {
      if (!stampKey) return;
      void api
        .post('/api/gears/stamp', { key: stampKey })
        .then(() => onStamped?.())
        .catch(() => undefined);
    };

    if (action === 'files') {
      setFileBrowserOpen(true);
      claimStamp();
      return;
    }
    if (action.startsWith('external:')) {
      openInNewTab(action.slice('external:'.length));
      claimStamp();
      return;
    }
    if (action.startsWith('navigate:')) {
      const target = action.slice('navigate:'.length);
      const [pathname, query] = target.split('?');
      const search = query ? Object.fromEntries(new URLSearchParams(query).entries()) : undefined;
      claimStamp();
      // Admin-authored paths aren't in TanStack's static route union.
      void navigate({ to: pathname, search } as never);
    }
  };
}
```

- [ ] **Step 4: Use it in the page**

In `app/routes/gears/index.tsx` replace the whole `const onCta = (gear: GearStatus) => { ... };` block (and its doc comment) with:

```tsx
const onCta = useGearCta(() => void refetch());
```

Add `import { useGearCta } from '@client/app/hooks/useGearCta';`. Remove now-unused `useNavigate`, `api`, `useFileBrowser`, `openInNewTab` imports and the `navigate` / `setFileBrowserOpen` locals.

- [ ] **Step 5: Run both tests**

Run: `pnpm --filter @bike4mind/client exec vitest run app/hooks/useGearCta.test.ts app/routes/gears/index.test.tsx`
Expected: PASS (page test unedited).

- [ ] **Step 6: Commit**

```
refactor(gears): share the gear CTA interpreter as useGearCta
```

---

### Task 3: Discovery logic (`lib/gears/discovery.ts`)

**Files:**
- Create: `apps/client/lib/gears/discovery.ts`
- Create: `apps/client/lib/gears/discovery.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DISCOVERY_MIN_ACCOUNT_AGE_MS: number; // 2 days
  export const DISCOVERY_COOLDOWN_MS: number;        // 3 days
  export const DISCOVERY_MIN_CANDIDATES = 3;
  export const DISCOVERY_MAX_CARDS = 5;
  export const DISCOVERY_SETTLE_MS = 5000;
  export const DISCOVERY_RECHECK_MS = 10_000;
  export const DISCOVERY_PRIORITY: readonly string[];
  export interface DiscoveryState { lastShownAt: number; dismissed: boolean; rotation: number }
  export const EMPTY_DISCOVERY_STATE: DiscoveryState;
  export function discoveryCandidates<T extends { key: string; unlocked: boolean; claimed?: boolean }>(gears: readonly T[]): T[];
  export function pickDiscoveryGears<T>(candidates: readonly T[], rotation: number): T[];
  export function shouldShowDiscovery(args: { createdAt: Date | string | number | null | undefined; state: DiscoveryState; candidateCount: number; now: number }): boolean;
  export function readDiscoveryState(userId: string): DiscoveryState;
  export function writeDiscoveryState(userId: string, state: DiscoveryState): void;
  ```

- [ ] **Step 1: Write the failing tests** `lib/gears/discovery.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DISCOVERY_COOLDOWN_MS,
  DISCOVERY_MIN_ACCOUNT_AGE_MS,
  DISCOVERY_PRIORITY,
  EMPTY_DISCOVERY_STATE,
  discoveryCandidates,
  pickDiscoveryGears,
  readDiscoveryState,
  shouldShowDiscovery,
  writeDiscoveryState,
} from './discovery';

const g = (key: string, unlocked = false, claimed = false) => ({ key, unlocked, claimed });
const NOW = Date.UTC(2026, 9, 26);
const OLD = NOW - DISCOVERY_MIN_ACCOUNT_AGE_MS - 1;

describe('discoveryCandidates', () => {
  it('drops used gears, unlocked or claimed', () => {
    expect(discoveryCandidates([g('agents', true), g('files', false, true), g('image')]).map(x => x.key)).toEqual([
      'image',
    ]);
  });

  it('orders by DISCOVERY_PRIORITY and appends unknown keys in input order', () => {
    const keys = discoveryCandidates([g('zzz-new'), g('image'), g('aaa-new'), g('models')]).map(x => x.key);
    expect(keys).toEqual(['models', 'image', 'zzz-new', 'aaa-new']);
  });

  it('starts with the most valuable gears', () => {
    expect(DISCOVERY_PRIORITY.slice(0, 3)).toEqual(['models', 'agents', 'projects']);
  });
});

describe('pickDiscoveryGears', () => {
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it('returns everything when there are 5 or fewer', () => {
    expect(pickDiscoveryGears(['a', 'b', 'c'], 10)).toEqual(['a', 'b', 'c']);
  });

  it('takes 5 starting at the rotation offset, wrapping', () => {
    expect(pickDiscoveryGears(seven, 0)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(pickDiscoveryGears(seven, 5)).toEqual(['f', 'g', 'a', 'b', 'c']);
    expect(pickDiscoveryGears(seven, 12)).toEqual(['f', 'g', 'a', 'b', 'c']);
  });
});

describe('shouldShowDiscovery', () => {
  const base = { createdAt: OLD, state: EMPTY_DISCOVERY_STATE, candidateCount: 3, now: NOW };

  it('shows for an eligible account', () => {
    expect(shouldShowDiscovery(base)).toBe(true);
  });

  it('waits until the account is older than 2 days', () => {
    expect(shouldShowDiscovery({ ...base, createdAt: NOW - DISCOVERY_MIN_ACCOUNT_AGE_MS + 1 })).toBe(false);
  });

  it('does not show without a usable createdAt', () => {
    expect(shouldShowDiscovery({ ...base, createdAt: undefined })).toBe(false);
    expect(shouldShowDiscovery({ ...base, createdAt: 'not a date' })).toBe(false);
  });

  it('needs at least 3 candidates', () => {
    expect(shouldShowDiscovery({ ...base, candidateCount: 2 })).toBe(false);
  });

  it('respects the 3-day cooldown', () => {
    const state = { ...EMPTY_DISCOVERY_STATE, lastShownAt: NOW - DISCOVERY_COOLDOWN_MS + 1 };
    expect(shouldShowDiscovery({ ...base, state })).toBe(false);
    expect(shouldShowDiscovery({ ...base, state: { ...state, lastShownAt: NOW - DISCOVERY_COOLDOWN_MS } })).toBe(true);
  });

  it('treats a lastShownAt in the future as never shown', () => {
    const state = { ...EMPTY_DISCOVERY_STATE, lastShownAt: NOW + 30 * DISCOVERY_COOLDOWN_MS };
    expect(shouldShowDiscovery({ ...base, state })).toBe(true);
  });

  it('never shows once dismissed', () => {
    expect(shouldShowDiscovery({ ...base, state: { ...EMPTY_DISCOVERY_STATE, dismissed: true } })).toBe(false);
  });
});

describe('discovery storage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips per user', () => {
    writeDiscoveryState('u1', { lastShownAt: 5, dismissed: true, rotation: 10 });
    expect(readDiscoveryState('u1')).toEqual({ lastShownAt: 5, dismissed: true, rotation: 10 });
    expect(readDiscoveryState('u2')).toEqual(EMPTY_DISCOVERY_STATE);
  });

  it('treats malformed values as empty, field by field', () => {
    localStorage.setItem('gears_discovery_u1', 'not json');
    expect(readDiscoveryState('u1')).toEqual(EMPTY_DISCOVERY_STATE);
    localStorage.setItem('gears_discovery_u1', '[1,2]');
    expect(readDiscoveryState('u1')).toEqual(EMPTY_DISCOVERY_STATE);
    localStorage.setItem('gears_discovery_u1', JSON.stringify({ lastShownAt: 'x', dismissed: 'yes', rotation: -3 }));
    expect(readDiscoveryState('u1')).toEqual(EMPTY_DISCOVERY_STATE);
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readDiscoveryState('u1')).toEqual(EMPTY_DISCOVERY_STATE);
    expect(() => writeDiscoveryState('u1', EMPTY_DISCOVERY_STATE)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter @bike4mind/client exec vitest run lib/gears/discovery.test.ts`
Expected: FAIL - cannot resolve `./discovery`.

- [ ] **Step 3: Implement** `lib/gears/discovery.ts`

```ts
/**
 * Gears discovery modal - which unused gears to suggest and when. Pure apart from
 * the localStorage helpers; the hook is app/hooks/useGearsDiscovery.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const DISCOVERY_MIN_ACCOUNT_AGE_MS = 2 * DAY_MS;
export const DISCOVERY_COOLDOWN_MS = 3 * DAY_MS;
export const DISCOVERY_MIN_CANDIDATES = 3;
export const DISCOVERY_MAX_CARDS = 5;
export const DISCOVERY_SETTLE_MS = 5000;
export const DISCOVERY_RECHECK_MS = 10_000;

/** Most valuable first. Keys not listed still appear, after these. */
export const DISCOVERY_PRIORITY: readonly string[] = [
  'models',
  'agents',
  'projects',
  'datalakes',
  'files',
  'research',
  'websearch',
  'published',
  'shareproject',
  'image',
  'voice',
  'video',
  'music',
  'sound',
  'react',
  'python',
  'mementos',
  'questmaster',
  'rapidreply',
  'mcp',
  'slack',
  'importopenai',
  'importclaude',
  'apikey',
  'apicall',
  'shareagent',
  'forknotebook',
  'downloadnotebook',
  'webfetch',
  'wolfram',
  'matheval',
  'mfa',
  'hearth',
  'clidocs',
];

export interface DiscoveryState {
  lastShownAt: number;
  dismissed: boolean;
  rotation: number;
}

export const EMPTY_DISCOVERY_STATE: DiscoveryState = { lastShownAt: 0, dismissed: false, rotation: 0 };

interface DiscoverableGear {
  key: string;
  unlocked: boolean;
  claimed?: boolean;
}

export function discoveryCandidates<T extends DiscoverableGear>(gears: readonly T[]): T[] {
  const rank = (key: string) => {
    const i = DISCOVERY_PRIORITY.indexOf(key);
    return i === -1 ? DISCOVERY_PRIORITY.length : i;
  };
  // Array sort is stable, so unlisted keys keep the endpoint's order.
  return gears.filter(g => !g.unlocked && !g.claimed).sort((a, b) => rank(a.key) - rank(b.key));
}

export function pickDiscoveryGears<T>(candidates: readonly T[], rotation: number): T[] {
  if (candidates.length <= DISCOVERY_MAX_CARDS) return [...candidates];
  const start = rotation % candidates.length;
  return Array.from({ length: DISCOVERY_MAX_CARDS }, (_, i) => candidates[(start + i) % candidates.length]);
}

export function shouldShowDiscovery({
  createdAt,
  state,
  candidateCount,
  now,
}: {
  createdAt: Date | string | number | null | undefined;
  state: DiscoveryState;
  candidateCount: number;
  now: number;
}): boolean {
  if (state.dismissed || candidateCount < DISCOVERY_MIN_CANDIDATES) return false;
  // A future timestamp means the clock moved back; honouring it could hide the modal for months.
  if (state.lastShownAt <= now && now - state.lastShownAt < DISCOVERY_COOLDOWN_MS) return false;
  if (!createdAt) return false;
  const createdMs = new Date(createdAt).getTime();
  return Number.isFinite(createdMs) && now - createdMs >= DISCOVERY_MIN_ACCOUNT_AGE_MS;
}

const storageKey = (userId: string) => `gears_discovery_${userId}`;

export function readDiscoveryState(userId: string): DiscoveryState {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return EMPTY_DISCOVERY_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_DISCOVERY_STATE;
    const o = parsed as Record<string, unknown>;
    return {
      lastShownAt: typeof o.lastShownAt === 'number' && Number.isFinite(o.lastShownAt) ? o.lastShownAt : 0,
      dismissed: o.dismissed === true,
      rotation: typeof o.rotation === 'number' && Number.isInteger(o.rotation) && o.rotation >= 0 ? o.rotation : 0,
    };
  } catch {
    return EMPTY_DISCOVERY_STATE;
  }
}

export function writeDiscoveryState(userId: string, state: DiscoveryState): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    // Private mode or quota: the worst case is the modal returning sooner.
  }
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `pnpm --filter @bike4mind/client exec vitest run lib/gears/discovery.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```
feat(gears): selection and eligibility rules for the discovery modal
```

---

### Task 4: Analytics events and the What's New session flag

**Files:**
- Modify: `b4m-core/common/src/schemas/analytics/events/firstRun.ts` (enum)
- Create: `apps/client/app/components/modals/whatsNewSession.ts`
- Create: `apps/client/app/components/modals/whatsNewSession.test.ts`
- Modify: `apps/client/app/contexts/ModalTriggerContext.tsx` (`triggerModalByTag`)

**Interfaces:**
- Produces: `FirstRunEvents.GEARS_DISCOVERY_SHOWN = 'gears_discovery_shown'`, `GEARS_DISCOVERY_CLICKED = 'gears_discovery_clicked'`, `GEARS_DISCOVERY_DISMISSED = 'gears_discovery_dismissed'`; `markWhatsNewShown(): void`, `wasWhatsNewShown(): boolean`, `resetWhatsNewShownForTests(): void`.

- [ ] **Step 1: Add the enum members** after `GEARS_PAGE_OPENED` in `firstRun.ts`:

```ts
  GEARS_DISCOVERY_SHOWN = 'gears_discovery_shown',
  GEARS_DISCOVERY_CLICKED = 'gears_discovery_clicked',
  GEARS_DISCOVERY_DISMISSED = 'gears_discovery_dismissed',
```

- [ ] **Step 2: Rebuild common**

Run: `pnpm --filter @bike4mind/common build`
Expected: success; `grep -c gears_discovery b4m-core/common/dist/index.mjs` prints a number >= 3.

- [ ] **Step 3: Write the failing flag test** `app/components/modals/whatsNewSession.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { markWhatsNewShown, resetWhatsNewShownForTests, wasWhatsNewShown } from './whatsNewSession';

describe('whatsNewSession', () => {
  beforeEach(() => resetWhatsNewShownForTests());

  it('is false until What\'s New opens, then stays true', () => {
    expect(wasWhatsNewShown()).toBe(false);
    markWhatsNewShown();
    expect(wasWhatsNewShown()).toBe(true);
  });
});
```

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/modals/whatsNewSession.test.ts` - Expected: FAIL (module missing).

- [ ] **Step 4: Implement** `app/components/modals/whatsNewSession.ts`

```ts
/** Whether What's New has opened in this page load; read by the gears discovery modal so the two never share a visit. */
let shown = false;

export const markWhatsNewShown = () => {
  shown = true;
};

export const wasWhatsNewShown = () => shown;

export const resetWhatsNewShownForTests = () => {
  shown = false;
};
```

- [ ] **Step 5: Mark it where the slider opens.** In `ModalTriggerContext.tsx`, `triggerModalByTag` is the single entry for both the auto and manual slider. Change it to:

```ts
  const triggerModalByTag = useCallback((tag: string, modalType?: ModalType, source: TriggerSource = 'manual') => {
    console.log('triggerModalByTag inside of TriggerContext:', tag);
    if (modalType === 'WhatsNewSlider') markWhatsNewShown();
    setModalType(modalType);
    setTriggerSource(source);
    setTagToTrigger(tag);
    setTriggerCounter(prevCounter => prevCounter + 1);
  }, []);
```

Add `import { markWhatsNewShown } from '@client/app/components/modals/whatsNewSession';`.

- [ ] **Step 6: Run the flag test and the existing context tests**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/modals/whatsNewSession.test.ts app/contexts`
Expected: PASS.

- [ ] **Step 7: Commit**

```
feat(gears): discovery analytics events and What's New session flag
```

---

### Task 5: `useGearsDiscovery` hook

**Files:**
- Create: `apps/client/app/hooks/useGearsDiscovery.ts`
- Create: `apps/client/app/hooks/useGearsDiscovery.test.ts`

**Interfaces:**
- Consumes: `useVisibleGears()` -> `{ gears: GearStatus[]; isPending: boolean; isError: boolean }`; `useGearCta()`; Task 3 exports; `wasWhatsNewShown()`; `isAnyModalDialogOpen()` from `@client/app/utils/anyDialogOpen`; `useUser(selector)`; `useStreamingState(selector)`; `useRouterState({ select })` and `useNavigate()` from `@tanstack/react-router`; `useLogEvent()` -> `{ mutate }`.
- Produces:
  ```ts
  export interface GearsDiscovery {
    open: boolean;
    gears: GearStatus[];
    close: () => void;
    dismissForever: () => void;
    seeAll: () => void;
    select: (gear: GearStatus, position: number) => void;
  }
  export function useGearsDiscovery(): GearsDiscovery;
  ```

- [ ] **Step 1: Write the failing tests** `app/hooks/useGearsDiscovery.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { FirstRunEvents } from '@bike4mind/common';
import { DISCOVERY_RECHECK_MS, DISCOVERY_SETTLE_MS, readDiscoveryState, writeDiscoveryState } from '@client/lib/gears/discovery';
import { markWhatsNewShown, resetWhatsNewShownForTests } from '@client/app/components/modals/whatsNewSession';

const DAY = 24 * 60 * 60 * 1000;

const h = vi.hoisted(() => ({
  gears: [] as GearStatus[],
  isPending: false,
  isError: false,
  user: { id: 'u1', createdAt: '' } as { id: string; createdAt: string } | null,
  streaming: false,
  pathname: '/',
  dialogOpen: false,
  navigate: vi.fn(),
  runCta: vi.fn(),
  logEvent: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@client/app/hooks/useVisibleGears', () => ({
  useVisibleGears: () => ({ gears: h.gears, isPending: h.isPending, isError: h.isError }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (sel: (s: { currentUser: typeof h.user }) => unknown) => sel({ currentUser: h.user }),
}));
vi.mock('@client/app/hooks/useStreamingState', () => ({
  useStreamingState: (sel: (s: { isAnyStreaming: () => boolean }) => unknown) =>
    sel({ isAnyStreaming: () => h.streaming }),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: h.pathname } }),
  useNavigate: () => h.navigate,
}));
vi.mock('@client/app/utils/anyDialogOpen', () => ({ isAnyModalDialogOpen: () => h.dialogOpen }));
vi.mock('@client/app/hooks/useGearCta', () => ({ useGearCta: () => h.runCta }));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: h.logEvent }) }));

import { useGearsDiscovery } from './useGearsDiscovery';

const gear = (key: string, overrides: Partial<GearStatus> = {}): GearStatus =>
  ({
    key,
    kind: 'skill',
    unlocked: false,
    credits: 250,
    title: key,
    tagline: '',
    intro: '',
    cta: `Try ${key}`,
    ctaAction: `navigate:/${key}`,
    ...overrides,
  }) as GearStatus;

const settle = () => act(() => vi.advanceTimersByTime(DISCOVERY_SETTLE_MS));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 26));
  localStorage.clear();
  resetWhatsNewShownForTests();
  h.gears = ['image', 'agents', 'websearch', 'video', 'models', 'slack', 'mcp'].map(k => gear(k));
  h.isPending = false;
  h.isError = false;
  h.user = { id: 'u1', createdAt: new Date(Date.now() - 10 * DAY).toISOString() };
  h.streaming = false;
  h.pathname = '/';
  h.dialogOpen = false;
  h.calls = [];
  h.navigate.mockReset();
  h.runCta.mockReset().mockImplementation(() => h.calls.push('cta'));
  h.logEvent.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('useGearsDiscovery', () => {
  it('opens after the settle delay with the top 5 by priority, and records the show', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    expect(result.current.open).toBe(false);
    settle();
    expect(result.current.open).toBe(true);
    expect(result.current.gears.map(g => g.key)).toEqual(['models', 'agents', 'websearch', 'image', 'video']);
    expect(readDiscoveryState('u1')).toEqual({ lastShownAt: Date.now(), dismissed: false, rotation: 5 });
    expect(h.logEvent).toHaveBeenCalledWith({
      type: FirstRunEvents.GEARS_DISCOVERY_SHOWN,
      metadata: { count: 5, keys: 'models,agents,websearch,image,video' },
    });
  });

  it('rotates on the next show', () => {
    writeDiscoveryState('u1', { lastShownAt: Date.now() - 4 * DAY, dismissed: false, rotation: 5 });
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    expect(result.current.gears.map(g => g.key)).toEqual(['mcp', 'slack', 'models', 'agents', 'websearch']);
  });

  it.each([
    ['status pending', () => (h.isPending = true)],
    ['status failed', () => (h.isError = true)],
    ['no user yet', () => (h.user = null)],
    ['on an admin page', () => (h.pathname = '/admin/users')],
    ['on the gears page', () => (h.pathname = '/gears')],
    ['inside the cooldown', () => writeDiscoveryState('u1', { lastShownAt: Date.now() - DAY, dismissed: false, rotation: 0 })],
  ])('stays closed and writes nothing new: %s', (_label, arrange) => {
    arrange();
    const before = localStorage.getItem('gears_discovery_u1');
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => vi.advanceTimersByTime(DISCOVERY_RECHECK_MS * 3));
    expect(result.current.open).toBe(false);
    expect(localStorage.getItem('gears_discovery_u1')).toBe(before);
  });

  it('waits while another dialog is visible, then opens', () => {
    h.dialogOpen = true;
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    expect(result.current.open).toBe(false);
    h.dialogOpen = false;
    act(() => vi.advanceTimersByTime(DISCOVERY_RECHECK_MS));
    expect(result.current.open).toBe(true);
  });

  it('waits while a response streams', () => {
    h.streaming = true;
    const { result, rerender } = renderHook(() => useGearsDiscovery());
    settle();
    expect(result.current.open).toBe(false);
    h.streaming = false;
    rerender();
    expect(result.current.open).toBe(true);
  });

  it('gives up for the page load once What\'s New has been shown', () => {
    markWhatsNewShown();
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => vi.advanceTimersByTime(DISCOVERY_RECHECK_MS * 3));
    expect(result.current.open).toBe(false);
    expect(localStorage.getItem('gears_discovery_u1')).toBeNull();
  });

  it('select closes before running the CTA and logs the click', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    const target = result.current.gears[1];
    act(() => result.current.select(target, 1));
    expect(result.current.open).toBe(false);
    expect(h.runCta).toHaveBeenCalledWith(target);
    expect(h.logEvent).toHaveBeenCalledWith({
      type: FirstRunEvents.GEARS_DISCOVERY_CLICKED,
      metadata: { key: target.key, position: 1 },
    });
  });

  it('dismissForever persists the flag', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => result.current.dismissForever());
    expect(result.current.open).toBe(false);
    expect(readDiscoveryState('u1').dismissed).toBe(true);
    expect(h.logEvent).toHaveBeenCalledWith({ type: FirstRunEvents.GEARS_DISCOVERY_DISMISSED, metadata: { how: 'never' } });
  });

  it('seeAll navigates to /gears; close only closes', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => result.current.seeAll());
    expect(h.navigate).toHaveBeenCalledWith({ to: '/gears' });
    expect(h.logEvent).toHaveBeenCalledWith({ type: FirstRunEvents.GEARS_DISCOVERY_DISMISSED, metadata: { how: 'see_all' } });
    expect(readDiscoveryState('u1').dismissed).toBe(false);
  });

  it('close logs a plain dismissal and leaves the cooldown to bring it back', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(h.logEvent).toHaveBeenCalledWith({ type: FirstRunEvents.GEARS_DISCOVERY_DISMISSED, metadata: { how: 'close' } });
    expect(readDiscoveryState('u1').dismissed).toBe(false);
  });
});
```

Note on `select` order: `h.runCta` is called synchronously inside the same `act`; the assertion that `open` is false after `act` plus `setShown(null)` being called before `runCta` in the implementation is what keeps a drawer CTA from opening under the backdrop. Keep that line order in Step 3.

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter @bike4mind/client exec vitest run app/hooks/useGearsDiscovery.test.ts`
Expected: FAIL - cannot resolve `./useGearsDiscovery`.

- [ ] **Step 3: Implement** `app/hooks/useGearsDiscovery.ts`

```ts
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { FirstRunEvents } from '@bike4mind/common';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { useVisibleGears } from '@client/app/hooks/useVisibleGears';
import { useGearCta } from '@client/app/hooks/useGearCta';
import { useUser } from '@client/app/contexts/UserContext';
import { useStreamingState } from '@client/app/hooks/useStreamingState';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { isAnyModalDialogOpen } from '@client/app/utils/anyDialogOpen';
import { wasWhatsNewShown } from '@client/app/components/modals/whatsNewSession';
import {
  DISCOVERY_MAX_CARDS,
  DISCOVERY_RECHECK_MS,
  DISCOVERY_SETTLE_MS,
  discoveryCandidates,
  pickDiscoveryGears,
  readDiscoveryState,
  shouldShowDiscovery,
  writeDiscoveryState,
} from '@client/lib/gears/discovery';

export interface GearsDiscovery {
  open: boolean;
  gears: GearStatus[];
  close: () => void;
  dismissForever: () => void;
  seeAll: () => void;
  select: (gear: GearStatus, position: number) => void;
}

/** Decides at most once per page load whether to show the gears discovery modal. Rules: lib/gears/discovery.ts. */
export function useGearsDiscovery(): GearsDiscovery {
  const userId = useUser(s => s.currentUser?.id);
  const createdAt = useUser(s => s.currentUser?.createdAt);
  const { gears, isPending, isError } = useVisibleGears();
  const isStreaming = useStreamingState(s => s.isAnyStreaming());
  const pathname = useRouterState({ select: s => s.location.pathname });
  const navigate = useNavigate();
  const runCta = useGearCta();
  const { mutate: logEvent } = useLogEvent();

  const [shown, setShown] = useState<GearStatus[] | null>(null);
  const [settled, setSettled] = useState(false);
  // isAnyModalDialogOpen reads the DOM, which no dependency tracks, so a blocked check is retried on a tick.
  const [tick, setTick] = useState(0);
  const decidedRef = useRef(false);

  useEffect(() => {
    if (isPending) return;
    const t = setTimeout(() => setSettled(true), DISCOVERY_SETTLE_MS);
    return () => clearTimeout(t);
  }, [isPending]);

  useEffect(() => {
    if (decidedRef.current || !settled || !userId || isError) return;
    if (pathname.startsWith('/admin') || pathname.startsWith('/gears')) return;
    if (wasWhatsNewShown()) {
      decidedRef.current = true;
      return;
    }
    if (isStreaming || isAnyModalDialogOpen()) {
      const t = setTimeout(() => setTick(n => n + 1), DISCOVERY_RECHECK_MS);
      return () => clearTimeout(t);
    }

    decidedRef.current = true;
    const now = Date.now();
    const state = readDiscoveryState(userId);
    const candidates = discoveryCandidates(gears);
    if (!shouldShowDiscovery({ createdAt, state, candidateCount: candidates.length, now })) return;

    const picked = pickDiscoveryGears(candidates, state.rotation);
    writeDiscoveryState(userId, { ...state, lastShownAt: now, rotation: state.rotation + DISCOVERY_MAX_CARDS });
    setShown(picked);
    logEvent({
      type: FirstRunEvents.GEARS_DISCOVERY_SHOWN,
      metadata: { count: picked.length, keys: picked.map(g => g.key).join(',') },
    });
  }, [settled, userId, isError, pathname, isStreaming, tick, gears, createdAt, logEvent]);

  const dismiss = (how: 'close' | 'never' | 'see_all') => {
    setShown(null);
    logEvent({ type: FirstRunEvents.GEARS_DISCOVERY_DISMISSED, metadata: { how } });
  };

  return {
    open: shown !== null,
    gears: shown ?? [],
    close: () => dismiss('close'),
    dismissForever: () => {
      if (userId) writeDiscoveryState(userId, { ...readDiscoveryState(userId), dismissed: true });
      dismiss('never');
    },
    seeAll: () => {
      dismiss('see_all');
      void navigate({ to: '/gears' });
    },
    select: (gear, position) => {
      // Closed first so a CTA that opens a drawer is not left under this modal's backdrop.
      setShown(null);
      logEvent({ type: FirstRunEvents.GEARS_DISCOVERY_CLICKED, metadata: { key: gear.key, position } });
      runCta(gear);
    },
  };
}
```

If `useUser`'s `createdAt` type is not assignable to `Date | string | number | null | undefined`, check `IUser.createdAt` in `@bike4mind/common` and widen the `shouldShowDiscovery` parameter type in Task 3 to match rather than casting.

- [ ] **Step 4: Run, confirm pass**

Run: `pnpm --filter @bike4mind/client exec vitest run app/hooks/useGearsDiscovery.test.ts`
Expected: PASS (all cases, including the `it.each` table).

- [ ] **Step 5: Commit**

```
feat(gears): useGearsDiscovery decides when to suggest unused gears
```

---

### Task 6: The modal and its mount

**Files:**
- Create: `apps/client/app/components/gears/GearsDiscoveryModal.tsx`
- Create: `apps/client/app/components/gears/GearsDiscoveryModal.test.tsx`
- Modify: `apps/client/app/components/layouts/Notebook/index.tsx` (mount after `<DataLakeUploadIndicator />`)
- Modify: `apps/client/app/components/layouts/Notebook/index.test.tsx` (mock the new module)

**Interfaces:**
- Consumes: `GearCard` (Task 1), `useGearsDiscovery` / `GearsDiscovery` (Task 5), `useIsMobile()`.
- Produces: `export const GearsDiscoveryModal: (props: GearsDiscoveryModalProps) => JSX.Element` (presentational) and `export default function GearsDiscovery(): JSX.Element` (container wiring the hook).
  ```ts
  interface GearsDiscoveryModalProps {
    open: boolean;
    gears: GearStatus[];
    onClose: () => void;
    onDismissForever: () => void;
    onSeeAll: () => void;
    onSelect: (gear: GearStatus, position: number) => void;
  }
  ```

- [ ] **Step 1: Write the failing test** `app/components/gears/GearsDiscoveryModal.test.tsx`

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';

vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import { GearsDiscoveryModal } from './GearsDiscoveryModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const gear = (key: string, credits = 250): GearStatus =>
  ({
    key,
    kind: 'skill',
    unlocked: false,
    credits,
    title: `${key} title`,
    tagline: '',
    intro: `${key} intro`,
    cta: `Try ${key}`,
    ctaAction: `navigate:/${key}`,
  }) as GearStatus;

const handlers = {
  onClose: vi.fn(),
  onDismissForever: vi.fn(),
  onSeeAll: vi.fn(),
  onSelect: vi.fn(),
};

const renderModal = (gears: GearStatus[], open = true) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GearsDiscoveryModal open={open} gears={gears} {...handlers} />
    </CssVarsProvider>
  );

beforeEach(() => Object.values(handlers).forEach(fn => fn.mockReset()));

describe('GearsDiscoveryModal', () => {
  it('renders the heading, the credit note and one card per gear with its CTA and reward', () => {
    renderModal([gear('agents', 1000), gear('image'), gear('mcp')]);
    const modal = screen.getByTestId('gears-discovery-modal');
    expect(within(modal).getByText("Don't miss these features")).toBeTruthy();
    expect(within(modal).getByText(/one-time credit bonus/)).toBeTruthy();
    expect(within(modal).getByTestId('gear-card-agents')).toBeTruthy();
    expect(within(modal).getByTestId('gear-cta-agents').textContent).toContain('Try agents');
    expect(within(modal).getByTestId('gear-reward-agents').textContent).toContain('1,000');
    expect(within(modal).queryByTestId('gear-claim-agents')).toBeNull();
  });

  it('selecting a card reports the gear and its position', async () => {
    renderModal([gear('agents'), gear('image'), gear('mcp')]);
    await userEvent.click(screen.getByTestId('gear-card-image'));
    expect(handlers.onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'image' }), 1);
  });

  it('activates a card from the keyboard', async () => {
    renderModal([gear('agents'), gear('image'), gear('mcp')]);
    screen.getByTestId('gear-card-mcp').focus();
    await userEvent.keyboard('{Enter}');
    expect(handlers.onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'mcp' }), 2);
  });

  it('wires the footer and close controls', async () => {
    renderModal([gear('agents'), gear('image'), gear('mcp')]);
    await userEvent.click(screen.getByTestId('gears-discovery-never-btn'));
    expect(handlers.onDismissForever).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('gears-discovery-see-all-btn'));
    expect(handlers.onSeeAll).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('gears-discovery-close-btn'));
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    renderModal([gear('agents'), gear('image'), gear('mcp')], false);
    expect(screen.queryByTestId('gears-discovery-modal')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/gears/GearsDiscoveryModal.test.tsx`
Expected: FAIL - cannot resolve `./GearsDiscoveryModal`.

- [ ] **Step 3: Implement** `app/components/gears/GearsDiscoveryModal.tsx`

```tsx
import { Box, Button, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { useGearsDiscovery } from '@client/app/hooks/useGearsDiscovery';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { GearCard } from './GearCard';

interface GearsDiscoveryModalProps {
  open: boolean;
  gears: GearStatus[];
  onClose: () => void;
  onDismissForever: () => void;
  onSeeAll: () => void;
  onSelect: (gear: GearStatus, position: number) => void;
}

export const GearsDiscoveryModal = ({
  open,
  gears,
  onClose,
  onDismissForever,
  onSeeAll,
  onSelect,
}: GearsDiscoveryModalProps) => {
  const isMobile = useIsMobile();
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        layout={isMobile ? 'fullscreen' : 'center'}
        data-testid="gears-discovery-modal"
        aria-labelledby="gears-discovery-title"
        sx={{ width: { sm: 'min(960px, calc(100vw - 48px))' }, overflowY: 'auto', p: { xs: '20px', sm: '28px' } }}
      >
        <ModalClose data-testid="gears-discovery-close-btn" />
        <Typography id="gears-discovery-title" level="h2" sx={{ fontWeight: 500, fontSize: '20px', pr: '32px' }}>
          Don&apos;t miss these features
        </Typography>
        <Typography level="body-sm" sx={{ mt: '6px', fontSize: '14px', fontWeight: 500, color: 'primary.500' }}>
          Each one pays a one-time credit bonus the first time you use it.
        </Typography>
        <Box
          sx={{
            mt: '24px',
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' },
            gap: 2,
          }}
        >
          {gears.map((gear, position) => (
            <GearCard key={gear.key} gear={gear} ctaLabel={gear.cta} onActivate={() => onSelect(gear, position)} />
          ))}
        </Box>
        <Stack direction="row" justifyContent="space-between" sx={{ mt: '24px' }}>
          <Button
            variant="plain"
            color="neutral"
            size="sm"
            onClick={onDismissForever}
            data-testid="gears-discovery-never-btn"
          >
            Don&apos;t show again
          </Button>
          <Button variant="plain" size="sm" onClick={onSeeAll} data-testid="gears-discovery-see-all-btn">
            See all gears
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default function GearsDiscovery() {
  const d = useGearsDiscovery();
  return (
    <GearsDiscoveryModal
      open={d.open}
      gears={d.gears}
      onClose={d.close}
      onDismissForever={d.dismissForever}
      onSeeAll={d.seeAll}
      onSelect={d.select}
    />
  );
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/gears/GearsDiscoveryModal.test.tsx`
Expected: PASS. If Joy's `ModalClose` does not forward `data-testid` to the button, put it via `slotProps={{ root: { 'data-testid': ... } }}` is not available on ModalClose - instead check the rendered DOM with `screen.debug()` and select by `getByRole('button', { name: /close/i })`, updating the test accordingly.

- [ ] **Step 5: Mount in the Notebook layout**

In `app/components/layouts/Notebook/index.tsx`:
```tsx
import GearsDiscovery from '@client/app/components/gears/GearsDiscoveryModal';
```
and after `<DataLakeUploadIndicator />`:
```tsx
      <GearsDiscovery />
```

In `app/components/layouts/Notebook/index.test.tsx`, next to the other component mocks (after line 13):
```tsx
vi.mock('@client/app/components/gears/GearsDiscoveryModal', () => ({ default: () => null }));
```

- [ ] **Step 6: Run the layout and all gears-related tests**

Run: `pnpm --filter @bike4mind/client exec vitest run app/components/layouts/Notebook app/components/gears app/hooks/useGearsDiscovery.test.ts app/hooks/useGearCta.test.ts app/routes/gears lib/gears app/components/modals/whatsNewSession.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```
feat(gears): discovery modal suggesting unused gears
```

---

### Task 7: Whole-branch verification

**Files:** none (fixes only if something fails).

- [ ] **Step 1: Client typecheck**

Run: `pnpm --filter @bike4mind/client typecheck 2>&1 | tail -20`
Expected: no errors in files this branch touched (`git diff --name-only main...HEAD`). Pre-existing errors elsewhere: note, do not fix.

- [ ] **Step 2: Lint (CI parity)**

Run: `pnpm lint:check`
Expected: clean.

- [ ] **Step 3: Client test suite**

Run: `VITEST_MAX_WORKERS=4 pnpm --filter @bike4mind/client test 2>&1 | tail -30`
Expected: all pass. Any failure outside the touched files: check it also fails on `main` before attributing it to this branch.

- [ ] **Step 4: ASCII check on added lines**

Run: `git diff main...HEAD -- '*.ts' '*.tsx' | grep '^+' | grep -nP '[^\x00-\x7F]'`
Expected: no output.

- [ ] **Step 5: Manual check in the running app** (use the `run` skill)

With dev tools open: `localStorage.removeItem('gears_discovery_<yourUserId>')`, reload, wait ~5 s on a chat page. Expect the modal with up to 5 cards in Gears-page style; card click lands in the feature; "Don't show again" sets `dismissed: true`; reload within the cooldown shows nothing; `/gears` page looks unchanged. Screenshot desktop and phone width.
