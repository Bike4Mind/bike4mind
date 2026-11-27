// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillSummary, SkillSource, SkillsScope, SkillsState } from '@shared/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillPicker } from './SkillPicker';
import {
  highlightedTokens,
  insertSkill,
  matchSkills,
  skillChipColor,
  skillQuery,
  skillSourceLabel,
  type SlashQuery,
} from './skillMenu';
import { useSkills, type SkillsController } from './useSkills';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SkillPicker', () => {
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

    it('tells "none installed" apart from "none match the filter"', () => {
      const renderEmpty = (installedCount: number) =>
        act(() =>
          root.render(
            <CssVarsProvider>
              <SkillPicker
                skills={[]}
                installedCount={installedCount}
                query="zzz"
                activeIndex={0}
                untrustedProject={null}
                onPick={() => {}}
                onTrustProject={() => {}}
                onBrowseMarket={() => {}}
              />
            </CssVarsProvider>
          )
        );

      renderEmpty(0);
      expect(container.querySelector('[data-testid="skill-picker-empty-text"]')?.textContent).toContain(
        'No skills found'
      );
      expect(container.querySelector('[data-testid="skill-picker-no-match-text"]')).toBeNull();

      renderEmpty(30);
      expect(container.querySelector('[data-testid="skill-picker-no-match-text"]')?.textContent).toBe(
        'No skills match /zzz.'
      );
      expect(container.querySelector('[data-testid="skill-picker-empty-text"]')).toBeNull();
      expect(container.querySelector('[data-testid="skill-picker-market-btn"]')).not.toBeNull();
    });

    it.each([0, 1])(
      'explains an empty filter beside the project trust banner with %i installed skills',
      installedCount => {
        act(() =>
          root.render(
            <CssVarsProvider>
              <SkillPicker
                skills={[]}
                installedCount={installedCount}
                query="zzz"
                activeIndex={0}
                untrustedProject="/repo"
                onPick={() => undefined}
                onTrustProject={() => undefined}
                onBrowseMarket={() => undefined}
              />
            </CssVarsProvider>
          )
        );
        expect(container.querySelector('[data-testid="skill-picker-trust"]')?.textContent).toContain('/repo');
        expect(container.querySelector('[data-testid="skill-trust-btn"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="skill-picker-market-btn"]')).not.toBeNull();
        const explanation = container.querySelector(
          installedCount > 0 ? '[data-testid="skill-picker-no-match-text"]' : '[data-testid="skill-picker-empty-text"]'
        );
        expect(explanation?.textContent).toContain(installedCount > 0 ? 'No skills match /zzz.' : 'No skills found');
      }
    );
  });
});

describe('skillMenu', () => {
  function skill(name: string, source: SkillSummary['source'], description = 'does a thing'): SkillSummary {
    return { name, source, description, filePath: `/tmp/${name}` };
  }

  describe('skillQuery', () => {
    it('opens on a bare slash', () => {
      expect(skillQuery('/')).toEqual({ query: '', start: 0, end: 1, wholeDraft: true });
    });

    it('filters as the name is typed', () => {
      expect(skillQuery('/rev')?.query).toBe('rev');
    });

    it('opens for a slash typed after a space, mid-sentence', () => {
      expect(skillQuery('fix the bug then /rev')).toEqual({ query: 'rev', start: 17, end: 21, wholeDraft: false });
      expect(skillQuery('first line\n/')?.query).toBe('');
    });

    it('follows the caret, not the end of the draft', () => {
      const draft = 'run /rev on the diff';
      expect(skillQuery(draft, 8)).toEqual({ query: 'rev', start: 4, end: 8, wholeDraft: false });
      // Mid-token: the name has characters glued on after the caret, so nothing is being composed.
      expect(skillQuery(draft, 6)).toBeNull();
      expect(skillQuery(draft, draft.length)).toBeNull();
    });

    it('stays shut for a slash inside a word or a path', () => {
      expect(skillQuery('fix the and/or')).toBeNull();
      expect(skillQuery('look at src/main')).toBeNull();
      expect(skillQuery('//')).toBeNull();
    });

    it('closes once arguments are being typed', () => {
      // The trailing space is what a selection inserts, so this is also what closes the menu
      // after the user picks something.
      expect(skillQuery('/review ')).toBeNull();
      expect(skillQuery('/review src/a.ts')).toBeNull();
    });

    it('calls a leading token the whole draft only when nothing follows it', () => {
      expect(skillQuery('/cle  ', 4)?.wholeDraft).toBe(true);
      expect(skillQuery('/cle and more', 4)?.wholeDraft).toBe(false);
    });
  });

  describe('insertSkill', () => {
    const at = (text: string, caret: number): SlashQuery => {
      const token = skillQuery(text, caret);
      if (!token) throw new Error('no token');
      return token;
    };

    it('replaces the token at the end of the draft and leaves the caret after a space', () => {
      expect(insertSkill('fix it then /rev', at('fix it then /rev', 16), 'review')).toEqual({
        text: 'fix it then /review ',
        caret: 20,
      });
    });

    it('keeps the words after the token, reusing the space already there', () => {
      expect(insertSkill('run /re on the diff', at('run /re on the diff', 7), 'review')).toEqual({
        text: 'run /review on the diff',
        caret: 12,
      });
    });

    it('adds a space before a following line rather than gluing the name to it', () => {
      expect(insertSkill('/re\nmore', at('/re\nmore', 3), 'review')).toEqual({ text: '/review \nmore', caret: 8 });
    });
  });

  describe('highlightedTokens', () => {
    const skills = new Set(['review', 'ship-it']);
    const isCommand = (name: string) => name === 'clear';

    it('marks known skills anywhere and leaves unknown names plain', () => {
      expect(highlightedTokens('please /review then /nope and /ship-it.', skills, isCommand)).toEqual([
        { name: 'review', start: 7, end: 14 },
        { name: 'ship-it', start: 30, end: 38 },
      ]);
    });

    it('marks only a leading skill, since later names are its arguments', () => {
      expect(highlightedTokens('/review then /ship-it', skills, isCommand)).toEqual([
        { name: 'review', start: 0, end: 7 },
      ]);
    });

    it('marks a command only where it would run', () => {
      expect(highlightedTokens('/clear', skills, isCommand)).toEqual([{ name: 'clear', start: 0, end: 6 }]);
      expect(highlightedTokens('then /clear', skills, isCommand)).toEqual([]);
    });
  });

  describe('matchSkills', () => {
    const skills = [
      skill('review', 'global'),
      skill('review-pr', 'project'),
      skill('deploy', 'project', 'ship the review build'),
      skill('lint', 'global'),
    ];

    it('skips the description fallback when namesOnly is set', () => {
      expect(matchSkills(skills, 'ship').map(entry => entry.name)).toEqual(['deploy']);
      expect(matchSkills(skills, 'ship', true)).toEqual([]);
    });

    it('returns everything for an empty query, project skills first', () => {
      expect(matchSkills(skills, '').map(entry => entry.name)).toEqual(['deploy', 'review-pr', 'lint', 'review']);
    });

    it('puts an exact name above a longer one that starts with it', () => {
      expect(matchSkills(skills, 'review').map(entry => entry.name)).toEqual(['review', 'review-pr']);
    });

    it('ignores descriptions while any name matches', () => {
      // 'deploy' only matches through its description. A short query would otherwise drag in most
      // of the list, since a skill description is a paragraph of prose.
      expect(matchSkills(skills, 'rev').map(entry => entry.name)).toEqual(['review-pr', 'review']);
    });

    it('falls back to descriptions when no name matches', () => {
      expect(matchSkills(skills, 'ship the').map(entry => entry.name)).toEqual(['deploy']);
    });

    it('puts account skills after global ones of the same rank', () => {
      const mixed = [skill('a-web', 'account'), skill('z-local', 'global'), skill('m-repo', 'project')];
      expect(matchSkills(mixed, '').map(entry => entry.name)).toEqual(['m-repo', 'z-local', 'a-web']);
    });

    it('is case insensitive', () => {
      expect(matchSkills(skills, 'LINT').map(entry => entry.name)).toEqual(['lint']);
    });

    it('returns nothing for a name no skill has', () => {
      expect(matchSkills(skills, 'nope')).toEqual([]);
    });
  });

  describe('skill chip presentation', () => {
    it.each([
      ['project', 'warning', 'Project'],
      ['global', 'neutral', 'Global'],
      ['account', 'primary', 'Bike4Mind'],
    ] as const)('presents %s as %s / %s', (source, color, label) => {
      expect(skillChipColor(source)).toBe(color);
      expect(skillSourceLabel(source)).toBe(label);
    });

    it('covers every source, so a new one cannot fall through to the global look', () => {
      const sources: SkillSource[] = ['project', 'global', 'account'];
      expect(sources.map(skillSourceLabel)).toEqual(['Project', 'Global', 'Bike4Mind']);
    });
  });
});

describe('useSkills', () => {
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

  const stateFor = (root: string | null): SkillsState => ({
    skills: [{ name: `skill-${root ?? 'global'}`, description: '', source: 'global', filePath: '/x' }],
    projectDirectory: root,
    untrustedProject: null,
  });

  let root: Root;
  let host: HTMLElement;
  let latest: SkillsController | null = null;
  const listSkills = vi.fn<(scope: SkillsScope) => Promise<SkillsState>>();
  const setProjectSkillsTrusted =
    vi.fn<(scope: SkillsScope, trusted: boolean, expectedProjectDirectory: string) => Promise<SkillsState>>();

  function Probe({ scope }: { scope: SkillsScope | null }) {
    latest = useSkills(scope);
    return (
      <CssVarsProvider>
        <SkillPicker
          skills={latest.skills}
          activeIndex={0}
          untrustedProject={latest.untrustedProject}
          onPick={() => undefined}
          onTrustProject={latest.trustProject}
        />
      </CssVarsProvider>
    );
  }

  const render = async (scope: SkillsScope | null) => {
    await act(async () => root.render(<Probe scope={scope} />));
  };

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    listSkills
      .mockReset()
      .mockImplementation(async scope => stateFor('draftDirectory' in scope ? scope.draftDirectory : 'session'));
    setProjectSkillsTrusted.mockReset().mockImplementation(async () => stateFor('trusted'));
    (window as unknown as { b4m: unknown }).b4m = { chat: { listSkills, setProjectSkillsTrusted } };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    latest = null;
  });

  describe('useSkills', () => {
    it('lists a Chat draft as global only, and reads nothing without a conversation', async () => {
      await render(null);
      expect(listSkills).not.toHaveBeenCalled();
      expect(latest?.skills).toEqual([]);

      await render({ draftDirectory: null });
      expect(listSkills).toHaveBeenCalledExactlyOnceWith({ draftDirectory: null });
      expect(latest?.skills.map(skill => skill.name)).toEqual(['skill-global']);
    });

    it('re-reads when the draft folder changes, but not on a re-render with the same folder', async () => {
      await render({ draftDirectory: '/a' });
      await render({ draftDirectory: '/a' });
      expect(listSkills).toHaveBeenCalledTimes(1);

      await render({ draftDirectory: '/b' });
      expect(listSkills).toHaveBeenLastCalledWith({ draftDirectory: '/b' });
      expect(latest?.projectDirectory).toBe('/b');
    });

    it('drops a slower read for a folder the draft has already left', async () => {
      let releaseFirst: (state: SkillsState) => void = () => undefined;
      listSkills.mockImplementationOnce(() => new Promise(resolve => (releaseFirst = resolve)));
      await render({ draftDirectory: '/old' });
      await render({ draftDirectory: '/new' });
      await act(async () => releaseFirst(stateFor('/old')));
      expect(latest?.projectDirectory).toBe('/new');
    });

    it('trusts the draft folder through the same scope', async () => {
      listSkills.mockResolvedValueOnce({ ...stateFor('/repo'), untrustedProject: '/repo' });
      await render({ draftDirectory: '/repo' });
      await act(async () => latest?.trustProject());
      expect(setProjectSkillsTrusted).toHaveBeenCalledExactlyOnceWith({ draftDirectory: '/repo' }, true, '/repo');
      expect(latest?.projectDirectory).toBe('trusted');
    });

    it('hides resolved project A while project B loads, then trusts only the displayed B', async () => {
      listSkills.mockResolvedValueOnce({ ...stateFor('/a'), untrustedProject: '/a' });
      await render({ draftDirectory: '/a' });
      expect(host.querySelector('[data-testid="skill-picker-trust"]')?.textContent).toContain('/a');
      const oldTrust = latest!.trustProject;
      let releaseB!: (state: SkillsState) => void;
      listSkills.mockImplementationOnce(() => new Promise(resolve => (releaseB = resolve)));
      await render({ draftDirectory: '/b' });
      expect(host.querySelector('[data-testid="skill-picker-trust"]')).toBeNull();
      expect(latest?.skills).toEqual([]);
      await act(async () => {
        await latest?.trustProject();
        await oldTrust();
      });
      expect(setProjectSkillsTrusted).not.toHaveBeenCalled();
      await act(async () => releaseB({ ...stateFor('/b'), untrustedProject: '/b' }));
      expect(host.querySelector('[data-testid="skill-picker-trust"]')?.textContent).toContain('/b');
      setProjectSkillsTrusted.mockResolvedValueOnce(stateFor('/b'));
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="skill-trust-btn"]')!.click());
      expect(setProjectSkillsTrusted).toHaveBeenCalledExactlyOnceWith({ draftDirectory: '/b' }, true, '/b');
      expect(latest?.projectDirectory).toBe('/b');
      expect(host.querySelector('[data-testid="skill-picker-trust"]')).toBeNull();
    });

    it('does not let an earlier trust response overwrite the next project', async () => {
      listSkills.mockResolvedValueOnce({ ...stateFor('/a'), untrustedProject: '/a' });
      await render({ draftDirectory: '/a' });
      let releaseTrust!: (state: SkillsState) => void;
      setProjectSkillsTrusted.mockImplementationOnce(() => new Promise(resolve => (releaseTrust = resolve)));
      let trusting!: Promise<void>;
      act(() => {
        trusting = latest!.trustProject();
      });
      await render({ draftDirectory: '/b' });
      await act(async () => {
        releaseTrust(stateFor('/a'));
        await trusting;
      });
      expect(setProjectSkillsTrusted).toHaveBeenCalledExactlyOnceWith({ draftDirectory: '/a' }, true, '/a');
      expect(latest?.projectDirectory).toBe('/b');
    });

    it('does not reuse the first A result or trust callback after an A to B to A round trip', async () => {
      listSkills.mockResolvedValueOnce({ ...stateFor('/a'), untrustedProject: '/a' });
      await render({ draftDirectory: '/a' });
      const oldTrust = latest!.trustProject;
      await render({ draftDirectory: '/b' });
      let releaseA!: (state: SkillsState) => void;
      listSkills.mockImplementationOnce(() => new Promise(resolve => (releaseA = resolve)));
      await render({ draftDirectory: '/a' });
      expect(host.querySelector('[data-testid="skill-picker-trust"]')).toBeNull();
      await act(async () => oldTrust());
      expect(setProjectSkillsTrusted).not.toHaveBeenCalled();
      await act(async () => releaseA({ ...stateFor('/a'), untrustedProject: '/a' }));
      await act(async () => latest?.trustProject());
      expect(setProjectSkillsTrusted).toHaveBeenCalledExactlyOnceWith({ draftDirectory: '/a' }, true, '/a');
    });

    it.each<SkillsScope | null>([{ sessionId: 'saved' }, { draftDirectory: null }, null])(
      'masks the previous project when switching to %j and rejects its stale trust callback',
      async nextScope => {
        listSkills.mockResolvedValueOnce({ ...stateFor('/a'), untrustedProject: '/a' });
        await render({ draftDirectory: '/a' });
        const oldTrust = latest!.trustProject;
        await render(nextScope);
        expect(host.querySelector('[data-testid="skill-picker-trust"]')).toBeNull();
        await act(async () => {
          await oldTrust();
          await latest?.trustProject();
        });
        expect(setProjectSkillsTrusted).not.toHaveBeenCalled();
        expect(latest?.projectDirectory).toBe(nextScope && 'sessionId' in nextScope ? 'session' : null);
      }
    );
  });
});
