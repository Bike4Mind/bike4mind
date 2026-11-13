// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillsScope, SkillsState } from '@shared/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSkills, type SkillsController } from './useSkills';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stateFor = (root: string | null): SkillsState => ({
  skills: [{ name: `skill-${root ?? 'global'}`, description: '', source: 'global', filePath: '/x' }],
  projectDirectory: root,
  untrustedProject: null,
});

let root: Root;
let host: HTMLElement;
let latest: SkillsController | null = null;
const listSkills = vi.fn<(scope: SkillsScope) => Promise<SkillsState>>();
const setProjectSkillsTrusted = vi.fn<(scope: SkillsScope, trusted: boolean) => Promise<SkillsState>>();

function Probe({ scope }: { scope: SkillsScope | null }) {
  latest = useSkills(scope);
  return null;
}

const render = async (scope: SkillsScope | null) => {
  await act(async () => root.render(<Probe scope={scope} />));
};

beforeEach(() => {
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
    await render({ draftDirectory: '/repo' });
    await act(async () => latest?.trustProject());
    expect(setProjectSkillsTrusted).toHaveBeenCalledExactlyOnceWith({ draftDirectory: '/repo' }, true);
    expect(latest?.projectDirectory).toBe('trusted');
  });
});
