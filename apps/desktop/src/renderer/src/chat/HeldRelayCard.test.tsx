// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ChatHeldRelay } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeldRelayCard } from './HeldRelayCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const held: ChatHeldRelay = {
  id: 'h1',
  sessionId: 's1',
  text: 'please run the migration',
  relay: { fromSessionId: 'sender-1', fromTitle: 'Docs pass', fromProject: 'docs', hops: 1 },
  heldAt: '2026-10-05T00:00:00.000Z',
  reason: 'other-project',
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: Partial<Parameters<typeof HeldRelayCard>[0]> = {}): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <HeldRelayCard held={[held]} onResolve={async () => {}} onOpenSession={() => {}} {...props} />
      </CssVarsProvider>
    );
  });
}

const byId = (testId: string) => host?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;

describe('HeldRelayCard', () => {
  it('draws nothing when no message is held', () => {
    mount({ held: [] });
    expect(byId('held-relay-card')).toBeNull();
  });

  it('names the sender and project and says why the message was held', () => {
    mount();
    const card = byId('held-relay-card');
    expect(card?.textContent).toContain('Message from Docs pass in docs');
    expect(card?.textContent).toContain('another project');
    expect(card?.textContent).toContain('please run the migration');
  });

  it('says the other reason in its own words', () => {
    mount({ held: [{ ...held, reason: 'looser-mode' }] });
    expect(byId('held-relay-card')?.textContent).toContain('do more without asking than the sender');
  });

  it('delivers or declines through the resolver', async () => {
    const onResolve = vi.fn(async () => {});
    mount({ onResolve });
    await act(async () => byId('held-relay-deliver-btn')?.click());
    await act(async () => byId('held-relay-decline-btn')?.click());
    expect(onResolve.mock.calls).toEqual([
      ['h1', true],
      ['h1', false],
    ]);
  });

  it('shows a failure inline and re-enables the buttons', async () => {
    mount({
      onResolve: async () => {
        throw new Error('gone');
      },
    });
    await act(async () => byId('held-relay-deliver-btn')?.click());
    expect(byId('held-relay-error')?.textContent).toContain('gone');
    expect(byId('held-relay-deliver-btn')?.hasAttribute('disabled')).toBe(false);
  });

  it('opens the sender from the title link', () => {
    const onOpenSession = vi.fn();
    mount({ onOpenSession });
    act(() => byId('held-relay-sender-link')?.click());
    expect(onOpenSession).toHaveBeenCalledWith('sender-1');
  });

  it('collapses a long message behind a toggle', () => {
    mount({ held: [{ ...held, text: 'x'.repeat(500) }] });
    const toggle = byId('held-relay-expand-toggle');
    expect(toggle?.textContent).toBe('Show more');
    act(() => toggle?.click());
    expect(byId('held-relay-expand-toggle')?.textContent).toBe('Show less');
  });
});
