// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { SkillsScope, SkillsState } from '@shared/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSkills, type SkillsController } from './useSkills';
import { SkillPicker } from './SkillPicker';

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
