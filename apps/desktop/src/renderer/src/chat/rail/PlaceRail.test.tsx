// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { StudioMediaKind } from '@shared/studio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioController } from '../studio/controller';
import { PlaceRail } from './PlaceRail';
import type { StudioArea } from './places';
import { StudioMain, StudioSidebar } from './StudioPlace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<CssVarsProvider>{node}</CssVarsProvider>));
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('the place rail', () => {
  it('shows Chat, Code, Studio and Agents, then the account slot, and no Library yet', () => {
    mount(<PlaceRail place="chat" onSelect={() => {}} account={<span data-testid="account-probe" />} />);
    const ids = [...document.querySelectorAll('[data-testid^="place-rail-"]')].map(node =>
      node.getAttribute('data-testid')
    );
    expect(ids).toEqual([
      'place-rail-chat-btn',
      'place-rail-code-btn',
      'place-rail-studio-btn',
      'place-rail-agents-btn',
    ]);
    expect(byTestId('place-rail')?.lastElementChild).toBe(byTestId('rail-foot'));
    expect(byTestId('rail-foot')?.lastElementChild).toBe(byTestId('account-probe'));
  });

  it('badges Agents with the needs-you count, capped, and only when there is one', () => {
    mount(<PlaceRail place="chat" onSelect={() => {}} needsYou={0} />);
    expect(byTestId('place-rail-agents-badge')).toBeNull();
    expect(byTestId('place-rail-agents-btn')?.getAttribute('aria-label')).toBe('Agents');
    act(() =>
      root?.render(
        <CssVarsProvider>
          <PlaceRail place="chat" onSelect={() => {}} needsYou={3} />
        </CssVarsProvider>
      )
    );
    expect(byTestId('place-rail-agents-badge')?.textContent).toBe('3');
    expect(byTestId('place-rail-agents-btn')?.getAttribute('aria-label')).toBe('Agents, 3 need you');
    act(() =>
      root?.render(
        <CssVarsProvider>
          <PlaceRail place="chat" onSelect={() => {}} needsYou={120} />
        </CssVarsProvider>
      )
    );
    expect(byTestId('place-rail-agents-badge')?.textContent).toBe('99+');
    expect(byTestId('place-rail-chat-badge')).toBeNull();
  });

  it('scrolls the places on a short window, keeping the account cluster outside the scroller', () => {
    mount(<PlaceRail place="chat" onSelect={() => {}} account={<span data-testid="account-probe" />} />);
    const places = byTestId('rail-places');
    expect(places?.contains(byTestId('place-rail-studio-btn'))).toBe(true);
    expect(places?.contains(byTestId('account-probe'))).toBe(false);
    expect(getComputedStyle(places as HTMLElement).overflowY).toBe('auto');
  });

  it('marks only the active place, and reports a click on another', () => {
    const onSelect = vi.fn();
    mount(<PlaceRail place="code" onSelect={onSelect} />);
    expect(byTestId('place-rail-code-btn')?.getAttribute('aria-current')).toBe('page');
    expect(byTestId('place-rail-chat-btn')?.hasAttribute('aria-current')).toBe(false);
    act(() => byTestId('place-rail-studio-btn')?.click());
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('studio');
  });

  it('names each button for assistive tech', () => {
    mount(<PlaceRail place="chat" onSelect={() => {}} />);
    expect(byTestId('place-rail-studio-btn')?.getAttribute('aria-label')).toBe('Studio');
  });
});

function controller(overrides: Partial<StudioController> = {}): StudioController {
  return {
    sessionId: 's1',
    workspaceId: 'w1',
    revision: 'r1',
    familyLabel: 'Session family',
    sessions: [],
    capabilities: { image: { status: 'available' }, video: { status: 'unsupported', reason: 'No video here.' } },
    state: { status: 'ready', assets: [], jobs: [] },
    prepareCreation: vi.fn(),
    create: vi.fn(),
    ...overrides,
  };
}

describe('the Studio place', () => {
  function Main(props: {
    area?: StudioArea;
    kind?: StudioMediaKind | null;
    ready?: boolean;
    unavailableReason?: string;
    onAreaChange?: (area: StudioArea) => void;
  }) {
    return (
      <StudioMain
        area={props.area ?? 'create'}
        onAreaChange={props.onAreaChange ?? (() => {})}
        kind={props.kind ?? null}
        onKindChange={() => {}}
        controller={controller()}
        ready={props.ready ?? true}
        unavailableReason={props.unavailableReason}
      />
    );
  }

  it('lists the media under Create in the sidebar, then Productions', () => {
    mount(
      <StudioSidebar
        width={260}
        area="create"
        kind={null}
        controller={controller()}
        onSelectKind={() => {}}
        onSelectArea={() => {}}
        onToggleCollapsed={() => {}}
      />
    );
    const sidebar = byTestId('studio-sidebar');
    expect(sidebar?.textContent).toContain('Create');
    for (const kind of ['image', 'video', 'music', 'speech', 'sound-effect'])
      expect(byTestId(`studio-sidebar-${kind}-btn`)).not.toBeNull();
    expect(byTestId('studio-sidebar-productions-btn')).not.toBeNull();
  });

  it('opens a medium from the sidebar, and holds back one the account cannot make', () => {
    const onSelectKind = vi.fn();
    mount(
      <StudioSidebar
        width={260}
        area="create"
        kind={null}
        controller={controller()}
        onSelectKind={onSelectKind}
        onSelectArea={() => {}}
        onToggleCollapsed={() => {}}
      />
    );
    act(() => byTestId('studio-sidebar-image-btn')?.click());
    expect(onSelectKind).toHaveBeenCalledExactlyOnceWith('image');
    expect(byTestId('studio-sidebar-video-btn')?.parentElement?.getAttribute('aria-disabled')).toBe('true');
  });

  it('heads the main pane with Create | Productions and switches between them', () => {
    const onAreaChange = vi.fn();
    mount(<Main onAreaChange={onAreaChange} />);
    expect(byTestId('studio-area-create')?.getAttribute('aria-selected')).toBe('true');
    act(() => byTestId('studio-area-productions')?.click());
    expect(onAreaChange).toHaveBeenCalledExactlyOnceWith('productions');
  });

  it('hosts the Studio tiles full width, with no borrowed conversation named', () => {
    mount(<Main />);
    expect(byTestId('studio-creation-tiles')).not.toBeNull();
    expect(byTestId('studio-create-session')).toBeNull();
  });

  it('says why Create is not ready while its Studio session is not bound', () => {
    mount(<Main ready={false} unavailableReason="Getting Studio ready..." />);
    expect(byTestId('studio-create-empty')?.textContent).toContain('Getting Studio ready...');
    expect(byTestId('studio-creation-tiles')).toBeNull();
  });

  it('keeps Productions a quiet coming-soon state', () => {
    mount(<Main area="productions" />);
    expect(byTestId('studio-productions-empty')?.textContent).toContain('coming to desktop');
  });
});
