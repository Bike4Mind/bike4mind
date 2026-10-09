// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { McpServerRequest } from '@shared/mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServerRequestCard } from './McpServerRequestCard';

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

const REQUEST: McpServerRequest = {
  name: 'cad',
  transport: 'stdio',
  command: '/usr/local/bin/uvx',
  args: ['some-server', '--port', '9875'],
  env_keys: [{ name: 'CAD_TOKEN', description: 'From the add-on settings' }],
  header_keys: [],
  reason: 'The vendor server for this program.',
};

/** React tracks an input's value itself; a plain assignment would be overwritten on render. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('McpServerRequestCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(warning?: string) {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <CssVarsProvider>
          <McpServerRequestCard
            request={REQUEST}
            update={false}
            {...(warning ? { warning } : {})}
            onApprove={onApprove}
            onDecline={onDecline}
          />
        </CssVarsProvider>
      )
    );
    const get = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    return { onApprove, onDecline, get };
  }

  it('shows the command and every argument verbatim, with the risk', () => {
    const { get } = render();
    expect(get('mcp-request-command').textContent).toContain('/usr/local/bin/uvx');
    const args = [...container.querySelectorAll('[data-testid="mcp-request-arg"]')].map(node => node.textContent);
    expect(args).toEqual(['some-server', '--port', '9875']);
    expect(get('mcp-request-risk').textContent).toContain('third-party program');
  });

  it('sends the typed secret with the approval and nothing on decline', () => {
    const first = render();
    const field = first.get('mcp-request-secret-input') as HTMLInputElement;
    expect(field.type).toBe('password');
    act(() => type(field, 'typed-value'));
    act(() => first.get('mcp-request-approve-btn').click());
    expect(first.onApprove).toHaveBeenCalledWith({ env: { CAD_TOKEN: 'typed-value' } });
    // Answered once: a second click does nothing.
    act(() => first.get('mcp-request-approve-btn').click());
    expect(first.onApprove).toHaveBeenCalledTimes(1);
  });

  it('declines without sending what was typed', () => {
    const { get, onApprove, onDecline } = render('argument 3 is a long random-looking string');
    expect(get('mcp-request-warning').textContent).toContain('argument 3');
    expect(get('mcp-request-approve-btn').textContent).toBe('Add anyway');
    act(() => type(get('mcp-request-secret-input') as HTMLInputElement, 'typed-value'));
    act(() => get('mcp-request-decline-btn').click());
    expect(onDecline).toHaveBeenCalledWith();
    expect(onApprove).not.toHaveBeenCalled();
  });
});
