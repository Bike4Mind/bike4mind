// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrchestratePill } from './OrchestratePill';
import { createThemedMount, el } from './testUtils';

const onChange = vi.fn();
const themed = createThemedMount();

afterEach(() => {
  themed.unmount();
  onChange.mockReset();
});

describe('OrchestratePill', () => {
  it('reflects the behaviour and flips it', async () => {
    await themed.render(<OrchestratePill on={false} onChange={onChange} />);
    const pill = el('composer-orchestrate-toggle');
    expect(pill.textContent).toBe('Orchestrate');
    expect(pill.getAttribute('aria-pressed')).toBe('false');
    act(() => pill.click());
    expect(onChange).toHaveBeenCalledWith(true);

    await themed.render(<OrchestratePill on onChange={onChange} />);
    expect(el('composer-orchestrate-toggle').getAttribute('aria-pressed')).toBe('true');
    act(() => el('composer-orchestrate-toggle').click());
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
