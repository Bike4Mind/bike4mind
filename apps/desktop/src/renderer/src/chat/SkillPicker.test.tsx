// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillSummary } from '@shared/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillPicker } from './SkillPicker';

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

const ACCOUNT: SkillSummary = {
  name: 'web-summary',
  description: 'Summarise a page.',
  source: 'account',
  filePath: 'b4m:/api/skills/a1',
};
const GLOBAL: SkillSummary = {
  name: 'lint',
  description: 'Lint the tree.',
  source: 'global',
  filePath: '/home/.claude/skills/lint/SKILL.md',
};

describe('the skill picker rows', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // jsdom has no layout, so the row's scroll-into-view is a no-op rather than a throw.
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (skills: SkillSummary[]) =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <SkillPicker
            skills={skills}
            activeIndex={0}
            untrustedProject={null}
            onPick={() => {}}
            onTrustProject={() => {}}
          />
        </CssVarsProvider>
      )
    );

  const rowFor = (name: string) =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="skill-picker-option"]')].find(candidate =>
      candidate.textContent?.includes(`/${name}`)
    );

  it('labels an account skill Bike4Mind and names its origin in the tooltip', () => {
    render([ACCOUNT]);

    const chip = rowFor('web-summary')?.querySelector<HTMLElement>('[data-testid="skill-picker-chip"]');
    expect(chip?.textContent).toBe('Bike4Mind');
    expect(chip?.getAttribute('title')).toBe('b4m:/api/skills/a1');
  });

  it('labels a local skill by its own source, not as the account', () => {
    render([GLOBAL]);

    const chip = rowFor('lint')?.querySelector<HTMLElement>('[data-testid="skill-picker-chip"]');
    expect(chip?.textContent).toBe('Global');
    expect(chip?.getAttribute('title')).toBe('/home/.claude/skills/lint/SKILL.md');
  });

  it('points an empty menu at the Skill Market, and only when it is empty', () => {
    const onBrowseMarket = vi.fn();
    const renderWith = (skills: SkillSummary[]) =>
      act(() =>
        root.render(
          <CssVarsProvider>
            <SkillPicker
              skills={skills}
              activeIndex={0}
              untrustedProject={null}
              onPick={() => {}}
              onTrustProject={() => {}}
              onBrowseMarket={onBrowseMarket}
            />
          </CssVarsProvider>
        )
      );

    renderWith([GLOBAL]);
    expect(container.querySelector('[data-testid="skill-picker-market-btn"]')).toBeNull();

    renderWith([]);
    const button = container.querySelector<HTMLElement>('[data-testid="skill-picker-market-btn"]');
    act(() => {
      button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onBrowseMarket).toHaveBeenCalledTimes(1);
  });
});
