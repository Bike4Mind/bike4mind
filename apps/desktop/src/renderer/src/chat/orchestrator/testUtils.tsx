import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { desktopTheme } from '../../theme';
import type { AgentState, AgentView } from './roster';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Joy's color-scheme hook reads matchMedia on mount; jsdom has none.
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

export const agentFixture = (id: string, state: AgentState = 'working', extra: Partial<AgentView> = {}): AgentView => ({
  id,
  title: `Agent ${id}`,
  parentId: 'root',
  depth: 1,
  seedPrompt: `seed ${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  model: 'm',
  state,
  ...extra,
});

/** One themed mount per test; call `unmount` in afterEach. `render` again to re-render in place. */
export function createThemedMount() {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  return {
    async render(node: ReactNode) {
      if (!root) {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
      }
      await act(async () => {
        root?.render(<CssVarsProvider theme={desktopTheme}>{node}</CssVarsProvider>);
      });
    },
    unmount() {
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    },
  };
}

export const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

export const el = (testId: string) => {
  const found = query(testId);
  if (!found) throw new Error(`no ${testId}`);
  return found;
};

export async function typeInto(input: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
