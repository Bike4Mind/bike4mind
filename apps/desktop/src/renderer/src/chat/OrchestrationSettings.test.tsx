// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inheritancePolicy } from '@shared/orchestration';
import { OrchestrationSettings, economicalWorkerPreset } from './OrchestrationSettings';
import { OrchestrationSummary } from './OrchestrationSummary';
import { createThemedMount, el } from './orchestrator/testUtils';

const models = [
  { id: 'current-sonnet', name: 'Current Sonnet', releaseDate: '2026-11-01', supportsTools: true },
  { id: 'older-sonnet', name: 'Older Sonnet', releaseDate: '2026-01-01', supportsTools: true },
  { id: 'planner', name: 'Available Opus', supportsTools: true },
];
const themed = createThemedMount();
const listModels = vi.fn(async () => ({
  models: [
    ...models,
    { id: 'blocked', name: 'Blocked', releaseDate: '2026-11-01', supportsTools: true, unavailable: 'Offline' },
  ],
}));
const getRolePolicy = vi.fn(async () => inheritancePolicy());
const setRolePolicy = vi.fn(async (policy: ReturnType<typeof inheritancePolicy>) => policy);
beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { b4m: unknown }).b4m = {
    chat: { getRolePolicy, setRolePolicy, listModels },
  };
});
afterEach(() => themed.unmount());

it('loads inheritance without migrating, applies a current catalog preset only on click, and saves only on explicit save', async () => {
  await themed.render(<OrchestrationSettings />);
  expect(setRolePolicy).not.toHaveBeenCalled();
  expect(el('orchestration-implementation-select').textContent).toContain('Inherit parent');
  await act(async () => el('orchestration-preset-btn').click());
  expect(setRolePolicy).not.toHaveBeenCalled();
  expect(el('orchestration-implementation-select').textContent).toContain('Current Sonnet');
  await act(async () => el('orchestration-save-btn').click());
  expect(setRolePolicy).toHaveBeenLastCalledWith({
    ...inheritancePolicy(),
    roles: { implementation: 'current-sonnet', exploration: 'current-sonnet', review: 'inherit' },
  });
});

it('offers no silent replacement preset when the catalog family is unavailable', () => {
  expect(economicalWorkerPreset([{ id: 'unknown', name: 'Unknown', supportsTools: true }])).toBeNull();
  expect(economicalWorkerPreset([{ ...models[0], unavailable: 'Offline' }])).toBeNull();
  expect(economicalWorkerPreset([{ ...models[0], supportsTools: false }])).toBeNull();
});

it('shows unavailable role configuration and actionable save failure inline', async () => {
  getRolePolicy.mockResolvedValueOnce({
    ...inheritancePolicy(),
    roles: { implementation: 'missing', exploration: 'inherit', review: 'inherit' },
  });
  setRolePolicy.mockRejectedValueOnce(new Error('Worker model missing is blocked. Choose a replacement.'));
  await themed.render(<OrchestrationSettings />);
  expect(document.body.textContent).toContain('Unavailable configuration: missing');
  await act(async () => el('orchestration-save-btn').click());
  expect(document.body.textContent).toContain('Choose a replacement');
});

it('summarizes planner and worker choices with current display names and unavailable state', async () => {
  await themed.render(
    <OrchestrationSummary
      root={{
        rootSessionId: 'root',
        rootRunId: 'run',
        policy: {
          ...inheritancePolicy(),
          roles: { implementation: 'current-sonnet', exploration: 'missing', review: 'inherit' },
        },
      }}
      planner="planner"
      models={models}
    />
  );
  const text = el('orchestration-policy-summary').textContent;
  expect(text).toContain('Planner: Available Opus');
  expect(text).toContain('implementation: Current Sonnet');
  expect(text).toContain('exploration: missing (unavailable; choose a replacement)');
  expect(text).toContain('review: inherit parent');
});

it('lets the user remove selected unavailable overrides and upgrades without a replacement preset', async () => {
  getRolePolicy.mockResolvedValueOnce({
    ...inheritancePolicy(),
    allowedOverrides: ['blocked'],
    escalation: { ...inheritancePolicy().escalation, allowedModels: ['missing'] },
  });
  await themed.render(<OrchestrationSettings />);
  expect(setRolePolicy).not.toHaveBeenCalled();
  await act(async () => el('orchestration-overrides-select').click());
  const blocked = el('orchestration-overrides-option-blocked');
  expect(blocked.getAttribute('aria-disabled')).not.toBe('true');
  await act(async () => blocked.click());
  await act(async () => el('orchestration-upgrade-models-select').click());
  await act(async () => el('orchestration-upgrade-models-option-missing').click());
  await act(async () => el('orchestration-save-btn').click());
  expect(setRolePolicy).toHaveBeenLastCalledWith(inheritancePolicy());
});
