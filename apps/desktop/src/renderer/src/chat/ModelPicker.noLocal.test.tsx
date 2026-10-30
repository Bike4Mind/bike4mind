// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { localModelId, NO_LOCAL_MODEL, type ChatModelOption } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from './ModelPicker';
import type { NoLocalModels } from './noLocalModels';
import type { ModelCatalogController } from './useChat';

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

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const qwen: ChatModelOption = { id: localModelId('ollama', 'qwen2.5:0.5b'), name: 'qwen2.5:0.5b' };

function mount(options: {
  noLocal?: NoLocalModels | null;
  models?: ChatModelOption[];
  modelId?: string;
  onOpenModels?: () => void;
}) {
  const reload = vi.fn(async () => {});
  const catalog: ModelCatalogController = {
    models: options.models ?? [],
    loading: false,
    error: 'Sign in to see models.',
    reload,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <ModelPicker
          catalog={catalog}
          modelId={options.modelId ?? 'claude-opus-5'}
          onSelect={vi.fn()}
          noLocal={options.noLocal ?? null}
          onOpenModels={options.onOpenModels ?? vi.fn()}
          local
        />
      </CssVarsProvider>
    );
  });
  act(() => el('model-picker-btn').click());
  return { reload };
}

const el = (testId: string) => {
  const found = document.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found as HTMLElement;
};

describe('ModelPicker with no local model', () => {
  it('names the empty state instead of the saved hosted model or a sign-in error', () => {
    mount({ noLocal: { reason: 'Ollama is not running at http://127.0.0.1:11434.', fix: null } });
    expect(el('model-picker-btn').textContent).toBe('No local model');
    expect(el('model-picker-no-local').textContent).toContain('Ollama is not running');
    expect(document.body.textContent).not.toContain('claude-opus-5');
    expect(document.body.textContent).not.toContain('Sign in');
    expect(document.querySelector('[data-testid="model-picker-open-models-item"]')).toBeNull();
  });

  it('makes the reason a focusable menu item that rechecks Ollama', () => {
    const { reload } = mount({ noLocal: { reason: 'Ollama is not running.', fix: null } });
    expect(el('model-picker-no-local').getAttribute('role')).toBe('menuitem');
    act(() => el('model-picker-no-local').click());
    expect(reload).toHaveBeenCalledOnce();
  });

  it('offers the Models screen when Ollama runs with no models', () => {
    const onOpenModels = vi.fn();
    mount({
      noLocal: { reason: 'Ollama is running but has no models that can chat.', fix: 'open-models' },
      onOpenModels,
    });
    act(() => el('model-picker-open-models-item').click());
    expect(onOpenModels).toHaveBeenCalledOnce();
  });

  it('keeps the model label while models are listed but Ollama stopped', () => {
    mount({ models: [qwen], modelId: qwen.id, noLocal: { reason: 'Ollama is not running.', fix: null } });
    expect(el('model-picker-btn').textContent).toBe('qwen2.5:0.5b');
    expect(el('model-picker-no-local').textContent).toContain('Ollama is not running');
  });

  it('shows a transitional label, not a raw id, for a hosted or placeholder model before main moves it', () => {
    mount({ models: [qwen], modelId: NO_LOCAL_MODEL });
    expect(el('model-picker-btn').textContent).toBe('Selecting model...');
    expect(document.querySelector('[data-testid="model-picker-unavailable"]')).toBeNull();
  });

  it('says a removed local model is not installed on this device, not missing from a server', () => {
    mount({ models: [qwen], modelId: localModelId('ollama', 'gone') });
    expect(el('model-picker-unavailable').textContent).toContain('not installed on this device');
  });
});
