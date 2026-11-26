// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { assignPersonas } from '@shared/agentPersona';
import type { OrchestratorViewProps } from './OrchestratorStage';
import type { OrchestratorViewId } from './orchestratorPrefs';
import type { AgentView } from './roster';
import { resetSkinsForTests, selectSkin, useApplySkin, useSkins, useSkinTheme, type SkinsState } from './skins';
import { sampleSkinSummary } from './sampleSkin';
import {
  DEFAULT_SKIN_THEME,
  STATE_PALETTE,
  mergeSkinTheme,
  skinCssVariables,
  stateLampColor,
  stateSkinSx,
} from './statePalette';
import { agentFixture, createThemedMount, el } from './testUtils';
import { renderOrchestratorView } from './viewRegistry';
import { AGENT_STATE_LABEL, type AgentState } from '@shared/agentState';

const themed = createThemedMount('dark');
const agents: AgentView[] = [
  agentFixture('w', 'working'),
  agentFixture('d', 'done'),
  agentFixture('s', 'stopped'),
  agentFixture('n', 'needs-you'),
];
const props: OrchestratorViewProps = {
  agents,
  parent: {},
  rootId: 'root-1',
  onSelect: vi.fn(),
  onInnkeeperSelect: vi.fn(),
  selectedId: null,
  introPlaying: false,
  personas: assignPersonas(agents),
};

/** What OrchestratorStage does for a view: read the active skin and put its colours on the root. */
function Skinned({ view }: { view: OrchestratorViewId }) {
  useApplySkin(useSkinTheme());
  return <>{renderOrchestratorView(view, props)}</>;
}

const rootVariable = (name: string) => document.documentElement.style.getPropertyValue(name);
const styleOf = (testId: string) => getComputedStyle(el(testId));
const emittedCss = () => [...document.querySelectorAll('style')].map(style => style.textContent).join('\n');
// jsdom leaves cssText empty, so read the colour properties the skin variables land in.
const COLOUR_PROPERTIES = ['background', 'backgroundColor', 'color', 'borderColor', 'boxShadow'] as const;
// Stops at the first match: jsdom's getComputedStyle re-cascades every stylesheet for each node it is asked about.
const colourUnderUses = (testId: string, variable: string) =>
  [el(testId), ...el(testId).querySelectorAll('*')].some(node => {
    const style = getComputedStyle(node);
    return COLOUR_PROPERTIES.some(property => style[property].includes(variable));
  });

/**
 * The sample skin's visible mark on each view that has one, beyond the root colours useApplySkin sets for all.
 * Plan, Swimlanes, Constellation and Transit only read those root colours.
 */
const SKINNED: Partial<Record<OrchestratorViewId, () => void>> = {
  tavern: () => {
    const img = el('orchestrator-tavern').querySelector('img');
    expect(img?.getAttribute('src')).toBe('b4m-skin://nightglass/sprites/tavern.png');
    expect(colourUnderUses('orchestrator-tavern', '--b4m-skin-state-working')).toBe(true);
  },
  office: () => {
    const img = el('orchestrator-office').querySelector('img');
    expect(img?.getAttribute('src')).toBe('b4m-skin://nightglass/sprites/office.png');
    expect(colourUnderUses('orchestrator-office', '--b4m-skin-state-working')).toBe(true);
  },
  aquarium: () => {
    const img = el('orchestrator-aquarium').querySelector('img');
    expect(img?.getAttribute('src')).toBe('b4m-skin://nightglass/sprites/tank.png');
    expect(colourUnderUses('orchestrator-aquarium', '--b4m-skin-state-working')).toBe(true);
  },
  board: () => {
    expect(colourUnderUses('orchestrator-board-column-working', '--b4m-skin-card')).toBe(true);
    // jsdom drops var() from border-color, so check the rule the muted chip emits.
    el('orchestrator-state-chip-stopped');
    expect(emittedCss()).toContain('border-color:var(--b4m-skin-state-stopped');
  },
  table: () => {
    expect(styleOf('orchestrator-state-chip-working').backgroundColor).toContain('--b4m-skin-state-working-soft');
  },
  'tile-wall': () => {
    expect(styleOf('orchestrator-tile-w').backgroundColor).toContain('--b4m-skin-card');
    const dot = el('orchestrator-tile-w').querySelector<HTMLElement>('[data-testid="orchestrator-tile-dot"]');
    expect(dot && getComputedStyle(dot).backgroundColor).toContain('--b4m-skin-state-working');
  },
};

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      onStreamEvent: vi.fn(() => () => undefined),
      onQueueChanged: vi.fn(() => () => undefined),
    },
  };
  resetSkinsForTests([sampleSkinSummary()], 'nightglass');
});

afterEach(() => {
  themed.unmount();
  resetSkinsForTests();
  window.localStorage.clear();
});

describe('the sample skin', () => {
  it.each(Object.keys(SKINNED) as OrchestratorViewId[])('renders on the %s view', async view => {
    await themed.render(<Skinned view={view} />);

    expect(rootVariable('--b4m-skin-state-working')).toBe('#3cc8ff');
    expect(rootVariable('--b4m-skin-stage')).toBe('#0f1a24');
    // Locked: the skin sets it, the merge drops it.
    expect(rootVariable('--b4m-skin-state-needs-you')).toBe('');
    SKINNED[view]?.();
  });

  it('comes off every view when Default is picked', async () => {
    await themed.render(<Skinned view="tavern" />);
    expect(rootVariable('--b4m-skin-state-working')).toBe('#3cc8ff');

    act(() => selectSkin(null));

    expect(rootVariable('--b4m-skin-state-working')).toBe('');
    expect(el('orchestrator-tavern').querySelector('img')?.getAttribute('src')).not.toContain('b4m-skin:');
    expect(window.localStorage.getItem('b4m.orchestrator.skin')).toBeNull();
  });

  it('keeps Default while the picked skin is broken', async () => {
    resetSkinsForTests(
      [{ status: 'broken', id: 'nightglass', name: 'Nightglass', error: 'tokens.json is missing' }],
      'nightglass'
    );
    await themed.render(<Skinned view="aquarium" />);
    expect(rootVariable('--b4m-skin-state-working')).toBe('');
    expect(el('orchestrator-aquarium').querySelector('img')?.getAttribute('src')).not.toContain('b4m-skin:');
  });
});

describe('the skins store', () => {
  async function readStore(): Promise<SkinsState> {
    let seen: SkinsState | undefined;
    const Probe = () => {
      seen = useSkins();
      return null;
    };
    await themed.render(<Probe />);
    if (!seen) throw new Error('store not read');
    return seen;
  }

  it('uses the default theme but keeps the pick while the picked skin is broken or missing', async () => {
    resetSkinsForTests([{ status: 'broken', id: 'nightglass', error: 'bad file' }], 'nightglass');
    const broken = await readStore();
    expect(broken.theme).toEqual(DEFAULT_SKIN_THEME);
    expect(broken.selectedId).toBe('nightglass');
    themed.unmount();

    resetSkinsForTests([sampleSkinSummary()], 'gone');
    const missing = await readStore();
    expect(missing.theme).toEqual(DEFAULT_SKIN_THEME);
    expect(missing.selectedId).toBe('gone');
  });
});

describe('statePalette', () => {
  const sources = import.meta.glob<string>(['./**/*.ts', './**/*.tsx', '!./**/*.test.*', '!./statePalette.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  describe('STATE_PALETTE', () => {
    it('colours every agent state', () => {
      for (const state of Object.keys(AGENT_STATE_LABEL) as AgentState[]) {
        expect(STATE_PALETTE[state].joy).toBeTruthy();
        expect(STATE_PALETTE[state].lamp).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });

    it('is the only place under chat/orchestrator that maps an agent state to a colour', () => {
      expect(Object.keys(sources).length).toBeGreaterThan(10);
      // A Record keyed by AgentState whose values are Joy colours or plain strings (hex) is a colour map.
      const colourMap = /Record<\s*AgentState\s*,\s*(ColorPaletteProp|string)\s*>/;
      const offenders = Object.entries(sources)
        .filter(([, source]) => colourMap.test(source))
        .map(([path]) => path);
      expect(offenders).toEqual([]);
    });
  });

  describe('mergeSkinTheme', () => {
    it('drops any state or surface colour that looks like the needs-you amber, keeping the rest', () => {
      const skin = sampleSkinSummary();
      if (skin.status !== 'ok') throw new Error('sample skin is broken');
      const theme = mergeSkinTheme({
        ...skin,
        tokens: {
          ...skin.tokens,
          states: { working: STATE_PALETTE['needs-you'].lamp, done: '#f0c050', failed: '#3cc8ff' },
          surfaces: { stage: '#ffcc00', card: '#16263a' },
        },
      });

      expect(theme.states).toEqual({ failed: '#3cc8ff' });
      expect(theme.surfaces).toEqual({ card: '#16263a' });
      expect(Object.values(skinCssVariables(theme, 'dark'))).not.toContain(STATE_PALETTE['needs-you'].lamp);
    });

    it('applies a skin over the palette', () => {
      const theme = mergeSkinTheme(sampleSkinSummary());
      expect(theme.id).toBe('nightglass');
      expect(theme.states).toMatchObject({ working: '#3cc8ff', done: '#b48cff', failed: '#ff5f87' });
      expect(theme.surfaces).toEqual({ stage: '#0f1a24', card: '#16263a' });
      expect(theme.fontFamily).toMatch(/monospace/);
      expect(theme.scenes.aquarium?.backdrop).toBe('b4m-skin://nightglass/sprites/tank.png');
      expect(theme.sounds.finale).toBe('b4m-skin://nightglass/sounds/finale.ogg');
    });

    it('locks the "needs you" colour and sound whatever the skin says', () => {
      const skin = sampleSkinSummary();
      // The sample deliberately sets both.
      expect(skin.tokens.states?.['needs-you']).toBe('#ff00ff');
      expect(skin.tokens.sounds?.['needs-you']).toBeDefined();

      const theme = mergeSkinTheme(skin);
      const variables = skinCssVariables(theme, 'dark');

      expect(theme.states).not.toHaveProperty('needs-you');
      expect(theme.sounds).toEqual({ finale: 'b4m-skin://nightglass/sounds/finale.ogg' });
      expect(Object.keys(variables).some(name => name.includes('needs-you'))).toBe(false);
      expect(Object.values(variables)).not.toContain('#ff00ff');
      expect(stateLampColor('needs-you')).toBe(STATE_PALETTE['needs-you'].lamp);
      expect(stateSkinSx('needs-you', 'solid')).toEqual({});
    });

    it('is the default for no skin or a broken one', () => {
      expect(mergeSkinTheme(undefined)).toBe(DEFAULT_SKIN_THEME);
      expect(mergeSkinTheme({ status: 'broken', id: 'x', error: 'bad' })).toBe(DEFAULT_SKIN_THEME);
      expect(skinCssVariables(DEFAULT_SKIN_THEME, 'light')).toEqual({});
    });

    it('drops surfaces its mode text could not be read on', () => {
      const dark = mergeSkinTheme(sampleSkinSummary());
      const light = { ...dark, surfaces: { stage: '#f4efe6', card: '#fbf8f2' } };

      expect(skinCssVariables(dark, 'light')).not.toHaveProperty('--b4m-skin-stage');
      expect(skinCssVariables(dark, 'light')).not.toHaveProperty('--b4m-skin-card');
      expect(skinCssVariables(dark, 'dark')).toMatchObject({
        '--b4m-skin-stage': '#0f1a24',
        '--b4m-skin-card': '#16263a',
      });
      expect(skinCssVariables(light, 'light')).toMatchObject({
        '--b4m-skin-stage': '#f4efe6',
        '--b4m-skin-card': '#fbf8f2',
      });
      expect(skinCssVariables(light, 'dark')).not.toHaveProperty('--b4m-skin-stage');
    });

    it('still applies state colours whatever the mode', () => {
      const theme = mergeSkinTheme(sampleSkinSummary());
      expect(skinCssVariables(theme, 'light')).toHaveProperty('--b4m-skin-state-working', '#3cc8ff');
    });

    it('reads a skinnable state through its variable, falling back to the palette', () => {
      expect(stateLampColor('working')).toBe('var(--b4m-skin-state-working, #ff9d3c)');
      expect(stateSkinSx('done', 'soft')).toEqual({
        backgroundColor: 'var(--b4m-skin-state-done-soft, var(--joy-palette-success-softBg))',
      });
    });
  });
});
