// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { OrchestratorViewProps } from './OrchestratorStage';
import { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from './orchestratorPrefs';
import type { AgentView } from './roster';
import { resetSkinsForTests, selectSkin, useApplySkin, useSkinTheme } from './skins';
import { sampleSkinSummary } from './sampleSkin';
import { agentFixture, createThemedMount, el } from './testUtils';
import { renderOrchestratorView } from './viewRegistry';

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
const stylesUnder = (testId: string) =>
  [el(testId), ...el(testId).querySelectorAll('*')]
    .flatMap(node => {
      const style = getComputedStyle(node);
      return COLOUR_PROPERTIES.map(property => style[property]);
    })
    .join('\n');

/** The sample skin's visible mark on each view, beyond the root colours every view reads. */
const SKINNED: Record<OrchestratorViewId, () => void> = {
  tavern: () => {
    const img = el('orchestrator-tavern').querySelector('img');
    expect(img?.getAttribute('src')).toBe('b4m-skin://nightglass/sprites/tavern.png');
    expect(stylesUnder('orchestrator-tavern')).toContain('--b4m-skin-state-working');
  },
  aquarium: () => {
    expect(rootVariable('--b4m-skin-aquarium-backdrop')).toBe('url("b4m-skin://nightglass/sprites/tank.png")');
    expect(styleOf('orchestrator-aquarium').backgroundImage).toContain('--b4m-skin-aquarium-backdrop');
  },
  board: () => {
    expect(stylesUnder('orchestrator-board-column-working')).toContain('--b4m-skin-card');
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
  (window as unknown as { b4m: unknown }).b4m = { chat: { getSession: vi.fn().mockResolvedValue(null) } };
  resetSkinsForTests([sampleSkinSummary()], 'nightglass');
});

afterEach(() => {
  themed.unmount();
  resetSkinsForTests();
  window.localStorage.clear();
});

describe('the sample skin', () => {
  it.each(ORCHESTRATOR_VIEWS)('renders on the %s view', async view => {
    await themed.render(<Skinned view={view} />);

    expect(rootVariable('--b4m-skin-state-working')).toBe('#3cc8ff');
    expect(rootVariable('--b4m-skin-stage')).toBe('#0f1a24');
    // Locked: the skin sets it, the merge drops it.
    expect(rootVariable('--b4m-skin-state-needs-you')).toBe('');
    SKINNED[view]();
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
    expect(rootVariable('--b4m-skin-aquarium-backdrop')).toBe('');
  });
});
