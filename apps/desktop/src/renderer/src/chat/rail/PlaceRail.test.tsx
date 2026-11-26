// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { StudioMediaKind } from '@shared/studio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioController } from '../studio/controller';
import { PlaceRail } from './PlaceRail';
import type { StudioArea } from './places';
import { StudioPane } from '../studio/StudioPane';
import { StudioMain } from './StudioPlace';

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
  it('shows Chat, Code, Studio, Agents and Library, then the account slot', () => {
    mount(<PlaceRail place="chat" onSelect={() => {}} account={<span data-testid="account-probe" />} />);
    const ids = [...document.querySelectorAll('[data-testid^="place-rail-"]')].map(node =>
      node.getAttribute('data-testid')
    );
    expect(ids).toEqual([
      'place-rail-chat-btn',
      'place-rail-code-btn',
      'place-rail-studio-btn',
      'place-rail-agents-btn',
      'place-rail-library-btn',
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
  // The payer note under Generate asks main who pays; left pending, it renders nothing.
  beforeEach(() => {
    (window as unknown as { b4m: unknown }).b4m = {
      account: { getSelection: () => new Promise(() => {}), onSelectionChanged: () => () => {} },
    };
  });

  function Main(props: {
    area?: StudioArea;
    kind?: StudioMediaKind | null;
    ready?: boolean;
    unavailableReason?: string;
    onAreaChange?: (area: StudioArea) => void;
    onKindChange?: (kind: StudioMediaKind | null) => void;
    productions?: React.ReactNode;
    library?: React.ReactNode;
  }) {
    return (
      <StudioMain
        area={props.area ?? 'create'}
        onAreaChange={props.onAreaChange ?? (() => {})}
        kind={props.kind ?? null}
        onKindChange={props.onKindChange ?? (() => {})}
        controller={controller()}
        ready={props.ready ?? true}
        unavailableReason={props.unavailableReason}
        productions={props.productions}
        library={props.library}
      />
    );
  }

  it('heads the place like web Studio: the title, then Create | Productions | Library', () => {
    const onAreaChange = vi.fn();
    mount(<Main onAreaChange={onAreaChange} />);
    expect(byTestId('studio-title')?.textContent).toBe('Studio');
    const tabs = [...(byTestId('studio-area-nav')?.querySelectorAll('[role="tab"]') ?? [])].map(tab => tab.textContent);
    expect(tabs).toEqual(['Create', 'Productions', 'Library']);
    expect(byTestId('studio-area-create')?.getAttribute('aria-selected')).toBe('true');
    act(() => byTestId('studio-area-productions')?.click());
    expect(onAreaChange).toHaveBeenCalledExactlyOnceWith('productions');
  });

  it('opens Create on Image, with the medium rail beside the form and its gallery', () => {
    mount(<Main />);
    const rail = byTestId('studio-medium-rail');
    for (const kind of ['image', 'video', 'music', 'speech', 'sound-effect'])
      expect(rail?.querySelector(`[data-testid="studio-rail-${kind}"]`)).not.toBeNull();
    expect(byTestId('studio-rail-image')?.getAttribute('aria-current')).toBe('page');
    expect(byTestId('studio-creation-form')).not.toBeNull();
    expect(byTestId('studio-gallery-title')?.textContent).toContain('Your images');
    // The pane's tile chooser is gone: a medium is always open, as on web.
    expect(byTestId('studio-creation-tiles')).toBeNull();
  });

  it('switches medium from the rail, and holds back one the account cannot make', () => {
    const onKindChange = vi.fn();
    mount(<Main kind="video" onKindChange={onKindChange} />);
    expect((byTestId('studio-rail-video') as HTMLButtonElement | null)?.disabled).toBe(true);
    act(() => (byTestId('studio-rail-image') as HTMLButtonElement | null)?.click());
    expect(onKindChange).toHaveBeenCalledExactlyOnceWith('image');
  });

  it('offers the session-context toggle only in the per-conversation pane, never in the place', () => {
    mount(<Main kind="image" />);
    expect(byTestId('studio-creation-form')).not.toBeNull();
    expect(byTestId('studio-use-session-context-checkbox')).toBeNull();
    expect(document.body.textContent).not.toContain('Use current session context');

    act(() => root?.unmount());
    host?.remove();
    mount(<StudioPane controller={controller()} variant="docked" onClose={() => {}} />);
    act(() => (byTestId('studio-create-image-tile') as HTMLButtonElement | null)?.click());
    expect(byTestId('studio-use-session-context-checkbox')).not.toBeNull();
  });

  it('says why Create is not ready while its Studio session is not bound', () => {
    mount(<Main ready={false} unavailableReason="Getting Studio ready..." />);
    expect(byTestId('studio-create-empty')?.textContent).toContain('Getting Studio ready...');
    expect(byTestId('studio-creation-form')).toBeNull();
  });

  describe('reusing a take', () => {
    const asset = {
      id: 'saved',
      kind: 'image' as const,
      title: 'Saved',
      originatingSessionId: 's1',
      createdAt: '2026-11-01',
      updatedAt: '2026-11-01',
      url: 'https://example.com/image.png',
      creation: { prompt: 'Prepared saved prompt', settings: { count: 2 }, selection: { mode: 'current-session' } },
    } as const;

    function Place({ value }: { value: StudioController }) {
      const [kind, setKind] = useState<StudioMediaKind | null>('image');
      return (
        <StudioMain
          area="create"
          onAreaChange={() => {}}
          kind={kind}
          onKindChange={setKind}
          controller={value}
          ready
          productions={undefined}
          library={undefined}
        />
      );
    }

    const placeController = () =>
      controller({
        capabilities: { image: { status: 'available' }, video: { status: 'available' } },
        state: { status: 'ready', assets: [{ ...asset, creation: { ...asset.creation } }], jobs: [] },
      });

    const click = (id: string) => act(async () => byTestId(id)?.click());
    const prompt = () => byTestId('studio-prompt-input') as HTMLTextAreaElement | null;
    const type = (value: string) =>
      act(async () => {
        const node = prompt();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, value);
        node?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const reuse = async () => {
      await click('studio-asset-saved-btn');
      await click('studio-asset-actions-btn');
      await click('studio-asset-reuse-btn');
    };

    it('submits no session context, whatever the reused take saved', async () => {
      const value = placeController();
      mount(<Place value={value} />);
      await reuse();
      expect(prompt()?.value).toBe('Prepared saved prompt');
      await click('studio-generate-btn');
      expect(value.prepareCreation).toHaveBeenCalledWith(
        expect.objectContaining({ selection: { mode: 'none' }, settings: { count: 2 } })
      );
    });

    it('drops the reused take once the medium changes and comes back', async () => {
      mount(<Place value={placeController()} />);
      await reuse();
      expect(prompt()?.value).toBe('Prepared saved prompt');
      await click('studio-rail-video');
      await click('studio-rail-image');
      expect(prompt()?.value).toBe('');
    });

    it('keeps the form up after a successful generate', async () => {
      const value = placeController();
      vi.mocked(value.prepareCreation).mockResolvedValue({ id: 'review', preparedPrompt: 'p' } as never);
      vi.mocked(value.create).mockResolvedValue(undefined as never);
      mount(<Place value={value} />);
      await type('A cat');
      await click('studio-generate-btn');
      expect(value.create).toHaveBeenCalled();
      expect(byTestId('studio-creation-form')).not.toBeNull();
    });

    it('shows only the current medium takes and closes an open preview on a medium change', async () => {
      const value = controller({
        capabilities: { image: { status: 'available' }, video: { status: 'available' } },
        state: {
          status: 'ready',
          assets: [asset, { ...asset, id: 'clip', kind: 'video' as const, title: 'Clip' }],
          jobs: [],
        },
      });
      mount(<Place value={value} />);
      expect(byTestId('studio-asset-saved-btn')).not.toBeNull();
      expect(byTestId('studio-asset-clip-btn')).toBeNull();
      await click('studio-asset-saved-btn');
      expect(byTestId('studio-asset-preview')).not.toBeNull();
      await click('studio-rail-video');
      expect(byTestId('studio-asset-preview')).toBeNull();
      expect(byTestId('studio-creation-form')).not.toBeNull();
      expect(byTestId('studio-asset-clip-btn')).not.toBeNull();
      expect(byTestId('studio-asset-saved-btn')).toBeNull();
    });

    it('keeps an unsent prompt while a take preview is open', async () => {
      mount(<Place value={placeController()} />);
      await type('Unsent draft');
      await click('studio-asset-saved-btn');
      expect(byTestId('studio-asset-preview')).not.toBeNull();
      await click('studio-preview-back-btn');
      expect(byTestId('studio-asset-preview')).toBeNull();
      expect(prompt()?.value).toBe('Unsent draft');
    });
  });

  it('mounts the Productions and Library bodies it is handed, or a quiet state without one', () => {
    mount(<Main area="productions" />);
    expect(byTestId('studio-productions-empty')?.textContent).toContain('coming to desktop');
    act(() => root?.unmount());
    host?.remove();
    mount(<Main area="productions" productions={<div data-testid="productions-body" />} />);
    expect(byTestId('productions-body')).not.toBeNull();
    expect(byTestId('studio-productions-empty')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    mount(<Main area="library" library={<div data-testid="library-body" />} />);
    expect(byTestId('library-body')).not.toBeNull();
  });
});
