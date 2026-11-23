// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LOOP_TEMPLATES } from '@bike4mind/common';
import { desktopTheme } from '../theme';
import { LoopFormModal, validateLoopForm } from './LoopFormModal';

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

const api = {
  pickFolder: vi.fn(async () => ({ ok: true, value: { directory: '/Users/me/repo' } })),
  createLoop: vi.fn(async () => ({ ok: true, value: { loop: { id: 'new-loop' } } })),
  updateLoop: vi.fn(),
};
const onSaved = vi.fn();
let root: Root;
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const type = (id: string, value: string) => {
  const input = byTestId(id) as HTMLInputElement | HTMLTextAreaElement;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(window, { b4m: { localLoops: api } });
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <LoopFormModal models={[{ id: 'm1', name: 'Model one' }]} onClose={() => undefined} onSaved={onSaved} />
      </CssVarsProvider>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

it('takes the folder only from the picker: no path input, and Save waits for a pick', async () => {
  const folder = byTestId('local-loops-form-folder')!;
  expect(folder.tagName).not.toBe('INPUT');
  expect(folder.querySelector('input')).toBeNull();
  expect((byTestId('local-loops-form-save-btn') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => byTestId('local-loops-form-folder-btn')!.click());
  expect(api.pickFolder).toHaveBeenCalled();
  expect(folder.textContent).toBe('/Users/me/repo');
  expect((byTestId('local-loops-form-save-btn') as HTMLButtonElement).disabled).toBe(false);
});

it('shows the shared validation errors and does not save', async () => {
  await act(async () => byTestId('local-loops-form-folder-btn')!.click());
  await act(async () => byTestId('local-loops-form-save-btn')!.click());
  expect(api.createLoop).not.toHaveBeenCalled();
  expect(document.body.textContent).toMatch(/name/i);
});

it('has no Slack or per-stage runner fields', () => {
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/slack/i);
  expect(text).not.toMatch(/runner/i);
  expect(document.querySelector('[data-testid^="loop-form-stage-runner"]')).toBeNull();
});

const choose = async (testId: string, label: string) => {
  const button = byTestId(testId)!;
  await act(async () => button.click());
  // Every Select in the dialog keeps its listbox mounted: look only in this one's.
  const listbox = document.getElementById(button.getAttribute('aria-controls') ?? '');
  const option = [...(listbox?.querySelectorAll('[role="option"]') ?? [])].find(node => node.textContent === label);
  await act(async () => (option as HTMLElement).click());
};

it('creates a loop from the typed fields and the picked folder', async () => {
  await act(async () => type('local-loops-form-name', 'Docs'));
  await act(async () => type('local-loops-form-goal', 'Keep the docs right'));
  await choose('local-loops-form-model', 'Model one');
  await act(async () => byTestId('local-loops-form-folder-btn')!.click());
  await act(async () => byTestId('local-loops-form-save-btn')!.click());
  expect(api.createLoop).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Docs', model: 'm1', directory: '/Users/me/repo', mirror: true, maxConcurrent: 1 })
  );
  expect(onSaved).toHaveBeenCalledWith('new-loop');
});

it('lets a loop oversee the other Desktop loops, never itself', async () => {
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <LoopFormModal
          models={[{ id: 'm1', name: 'Model one' }]}
          loops={[{ id: 'l2', name: 'Docs worker' }]}
          onClose={() => undefined}
          onSaved={onSaved}
        />
      </CssVarsProvider>
    )
  );
  await act(async () => type('local-loops-form-name', 'Overseer'));
  await act(async () => type('local-loops-form-goal', 'Keep the docs loop moving'));
  await choose('local-loops-form-model', 'Model one');
  await choose('local-loops-form-oversees', 'Docs worker');
  await act(async () => byTestId('local-loops-form-folder-btn')!.click());
  await act(async () => byTestId('local-loops-form-save-btn')!.click());
  expect(api.createLoop).toHaveBeenCalledWith(expect.objectContaining({ oversees: ['l2'] }));
});

it('shows no Oversees field when there is no other loop', () => {
  expect(byTestId('local-loops-form-oversees')).toBeNull();
});

it('validates like main does', () => {
  expect(validateLoopForm(baseValues())).toEqual({});
  expect(validateLoopForm({ ...baseValues(), name: '' }).name).toBeDefined();
  expect(validateLoopForm({ ...baseValues(), stages: [] }).stages).toBeDefined();
  expect(validateLoopForm({ ...baseValues(), budget: '-5' }).budget).toBeDefined();
  expect(validateLoopForm({ ...baseValues(), directory: '' }).directory).toBe('Choose the folder this loop works in.');
});

it('fills name, goal and stages from a template', async () => {
  const template = LOOP_TEMPLATES[0];
  await choose('local-loops-form-template', template.name);
  expect((byTestId('local-loops-form-name') as HTMLInputElement).value).toBe(template.name);
  expect(byTestId(`local-loops-form-stage-panel-0`)?.textContent).toContain(template.stages[0]);
});

function baseValues() {
  return {
    name: 'Docs',
    goal: 'Keep the docs right',
    stages: ['todo', 'done'],
    stageConfig: {},
    model: 'm1',
    escalationModel: '',
    fallbackModel: '',
    maxConcurrent: 1,
    budget: '',
    p2RunsPerDay: '',
    approvalMode: 'auto' as const,
    mirror: true,
    directory: '/Users/me/repo',
    oversees: [],
  };
}
