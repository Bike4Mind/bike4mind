// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inheritancePolicy, type RootPolicy } from '@shared/orchestration';
import { OrchestratePill } from './OrchestratePill';
import { createThemedMount, el, query } from './testUtils';

const onChange = vi.fn();
const themed = createThemedMount();

afterEach(() => {
  themed.unmount();
  onChange.mockReset();
});

const models = [
  { id: 'planner', name: 'Available Opus', supportsTools: true },
  { id: 'current-sonnet', name: 'Current Sonnet', supportsTools: true },
];
const policyWith = (roles: RootPolicy['policy']['roles']): RootPolicy => ({
  rootSessionId: 'root',
  rootRunId: 'run',
  policy: { ...inheritancePolicy(), roles },
});

async function hoverTooltip(): Promise<HTMLElement | null> {
  await act(async () => {
    el('composer-orchestrate-toggle').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    // Joy's Tooltip opens after its enter delay (100ms).
    await new Promise(resolve => setTimeout(resolve, 150));
  });
  return document.body.querySelector<HTMLElement>('[role="tooltip"]');
}

describe('OrchestratePill', () => {
  it('reflects the behaviour and flips it', async () => {
    await themed.render(<OrchestratePill on={false} onChange={onChange} />);
    const pill = el('composer-orchestrate-toggle');
    expect(pill.getAttribute('aria-label')).toBe('Orchestrate');
    expect(pill.getAttribute('aria-pressed')).toBe('false');
    act(() => pill.click());
    expect(onChange).toHaveBeenCalledWith(true);

    await themed.render(<OrchestratePill on onChange={onChange} />);
    expect(el('composer-orchestrate-toggle').getAttribute('aria-pressed')).toBe('true');
    act(() => el('composer-orchestrate-toggle').click());
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the run policy in its tooltip while on', async () => {
    await themed.render(
      <OrchestratePill
        on
        policy={policyWith({ implementation: 'current-sonnet', exploration: 'inherit', review: 'inherit' })}
        planner="planner"
        models={models}
        onChange={onChange}
      />
    );
    expect(query('orchestration-policy-summary')).toBeNull();
    const tooltip = await hoverTooltip();
    expect(tooltip?.textContent).toContain('Orchestrate on: new work is split across agents');
    const summary = el('orchestration-policy-summary').textContent;
    expect(summary).toContain('Planner: Available Opus');
    expect(summary).toContain('implementation: Current Sonnet');
    expect(summary).toContain('review: inherit parent');
    expect(summary).toContain('Worker defaults are in Settings.');
    expect(summary).toContain('Active tasks retain this run policy.');
    expect(query('composer-orchestrate-unavailable')).toBeNull();
    expect(el('composer-orchestrate-toggle').getAttribute('aria-label')).toBe('Orchestrate');
  });

  it('marks the icon and flags the role when a policy model is unavailable', async () => {
    await themed.render(
      <OrchestratePill
        on
        policy={policyWith({ implementation: 'inherit', exploration: 'missing', review: 'inherit' })}
        planner="planner"
        models={models}
        onChange={onChange}
      />
    );
    expect(query('composer-orchestrate-unavailable')).not.toBeNull();
    expect(el('composer-orchestrate-toggle').getAttribute('aria-label')).toMatch(/unavailable/);
    await hoverTooltip();
    expect(el('orchestration-policy-summary').textContent).toContain(
      'exploration: missing (unavailable; choose a replacement)'
    );
  });

  it('keeps the plain label and no policy while off', async () => {
    await themed.render(
      <OrchestratePill
        on={false}
        policy={policyWith({ implementation: 'missing', exploration: 'inherit', review: 'inherit' })}
        planner="planner"
        models={models}
        onChange={onChange}
      />
    );
    const tooltip = await hoverTooltip();
    expect(tooltip?.textContent).toBe('Orchestrate: split work across agents');
    expect(query('orchestration-policy-summary')).toBeNull();
    expect(query('composer-orchestrate-unavailable')).toBeNull();
  });
});
