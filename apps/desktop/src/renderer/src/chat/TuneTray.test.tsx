// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PromptCacheTtl } from '@bike4mind/common';
import type { ChatApprovalMode, ChatModelOption, ReasoningEffortSetting } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalModePill } from './ApprovalModePill';
import { compactModelName } from './ModelPicker';
import { PromptCacheTtlPicker } from './PromptCacheTtlPicker';
import { ReasoningEffortPicker } from './ReasoningEffortPicker';
import { TuneTray } from './TuneTray';

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

const OPUS: ChatModelOption = {
  id: 'claude-opus-5-5',
  name: 'Claude Opus 5.5',
  supportsReasoningEffort: true,
  supportsOneHourCache: true,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function Knobs({
  initialEffort = 'default',
  initialTtl = '5m',
  onEffort = () => {},
}: {
  initialEffort?: ReasoningEffortSetting;
  initialTtl?: PromptCacheTtl;
  onEffort?: (effort: ReasoningEffortSetting) => void;
}) {
  const [effort, setEffort] = useState<ReasoningEffortSetting>(initialEffort);
  const [ttl, setTtl] = useState<PromptCacheTtl>(initialTtl);
  return (
    <CssVarsProvider>
      <TuneTray>
        {compact => (
          <>
            <ReasoningEffortPicker
              models={[OPUS]}
              modelId={OPUS.id}
              effort={effort}
              compact={compact}
              onSelect={next => {
                onEffort(next);
                setEffort(next);
              }}
            />
            <PromptCacheTtlPicker model={OPUS} ttl={ttl} contextTokens={0} compact={compact} onSelect={setTtl} />
          </>
        )}
      </TuneTray>
    </CssVarsProvider>
  );
}

describe('the composer tune tray', () => {
  it('shows no knob that sits at its default while closed', () => {
    act(() => root.render(<Knobs />));
    expect(byTestId('effort-picker-btn')).toBeNull();
    expect(byTestId('prompt-cache-ttl-picker-btn')).toBeNull();
    expect(byTestId('composer-tune-btn')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a changed knob on the row, and its reset puts it back to the default', () => {
    const onEffort = vi.fn<(effort: ReasoningEffortSetting) => void>();
    act(() => root.render(<Knobs initialEffort="high" initialTtl="1h" onEffort={onEffort} />));
    expect(byTestId('effort-picker-btn')?.textContent).toBe('Effort: High');
    expect(byTestId('prompt-cache-ttl-picker-btn')?.textContent).toBe('Cache: 1h');

    act(() => byTestId('effort-picker-reset-btn')?.click());
    expect(onEffort).toHaveBeenCalledWith('default');
    expect(byTestId('effort-picker-btn')).toBeNull();

    act(() => byTestId('prompt-cache-ttl-picker-reset-btn')?.click());
    expect(byTestId('prompt-cache-ttl-picker-btn')).toBeNull();
  });

  it('lays every knob out, defaults included, once opened', () => {
    act(() => root.render(<Knobs />));
    act(() => byTestId('composer-tune-btn')?.click());

    const toggle = byTestId('composer-tune-btn');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Hide model settings');
    expect(byTestId('composer-tune-tray')?.id).toBe(toggle?.getAttribute('aria-controls'));
    expect(byTestId('effort-picker-btn')?.textContent).toBe('Effort: Default');
    expect(byTestId('prompt-cache-ttl-picker-btn')?.textContent).toBe('Cache: 5m');
    // No resets in the open tray: each knob's own menu holds its default.
    expect(byTestId('effort-picker-reset-btn')).toBeNull();
  });
});

describe('the approval mode button', () => {
  function render(mode: ChatApprovalMode) {
    act(() =>
      root.render(
        <CssVarsProvider>
          <ApprovalModePill mode={mode} onSelect={() => {}} />
        </CssVarsProvider>
      )
    );
    const button = byTestId('approval-mode-btn');
    if (!button) throw new Error('The approval mode button is missing');
    return button;
  }

  it('shows only an icon for the asking modes, and names the mode for assistive tech', () => {
    for (const [mode, label] of [
      ['ask', 'Ask for approval'],
      ['auto', 'Approve for me'],
    ] as const) {
      const button = render(mode);
      expect(button.textContent).toBe('');
      expect(button.getAttribute('aria-label')).toBe(`Approvals: ${label}`);
      expect(button.dataset.mode).toBe(mode);
    }
  });

  it('keeps "Full access" written out, so the riskiest mode is never just an icon', () => {
    expect(render('full').textContent).toBe('Full access');
  });
});

describe('compactModelName', () => {
  it('drops the vendor word only in front of a Claude family name', () => {
    expect(compactModelName('Claude Opus 5.5')).toBe('Opus 5.5');
    expect(compactModelName('Claude Haiku 5.5')).toBe('Haiku 5.5');
    expect(compactModelName('Claude Instant')).toBe('Claude Instant');
    expect(compactModelName('Gemini 2.5 Pro')).toBe('Gemini 2.5 Pro');
  });
});
