// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatProject, ProjectInspection, RecentFolder } from '@shared/chat';
import type { AppInfo } from '@shared/ipc';
import { SessionChips } from './SessionChips';
import type { ProjectBindingController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTAINER = '/Users/someone/code/thing';
const CHECKOUT = `${CONTAINER}/main`;
const WORKTREE = `${CONTAINER}/feat+chips`;

function project(over: Partial<ChatProject> = {}): ChatProject {
  return {
    directory: CHECKOUT,
    name: 'thing',
    branch: 'main',
    workspace: false,
    workingDirectory: CHECKOUT,
    contextDirectories: [],
    ...over,
  };
}

function inspection(over: Partial<ProjectInspection> = {}): ProjectInspection {
  return {
    directory: CHECKOUT,
    name: 'thing',
    isRepository: true,
    branches: ['main', 'feat/chips'],
    currentBranch: 'main',
    ...over,
  };
}

const getAppInfo = async (): Promise<Partial<AppInfo>> => ({ homeDirectory: '' });
const listRecentFolders = async (): Promise<RecentFolder[]> => [];

const binding: ProjectBindingController = {
  busy: false,
  error: null,
  dismissError: vi.fn(),
  pickDirectory: vi.fn(),
  chooseDirectory: vi.fn(),
  setBranch: vi.fn(),
  setWorkspace: vi.fn(),
  moveToCheckout: vi.fn(),
  worktreeFrom: vi.fn(),
  addContextDirectory: vi.fn(),
  removeContextDirectory: vi.fn(),
};

describe('the branch chip against what git answers', () => {
  let host: HTMLDivElement;
  let root: Root;
  const inspectProject = vi.fn();

  async function show(bound: ChatProject, settledTurns = 0): Promise<void> {
    await act(async () => root.render(<SessionChips project={bound} binding={binding} settledTurns={settledTurns} />));
    await act(async () => undefined);
  }

  const label = (): string | undefined =>
    host.querySelector('[data-testid="session-chip-branch-btn"]')?.textContent ?? undefined;

  beforeEach(() => {
    inspectProject.mockReset();
    (window as unknown as { b4m: unknown }).b4m = { chat: { inspectProject, listRecentFolders }, getAppInfo };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('names the branch an ordinary checkout is on', async () => {
    inspectProject.mockResolvedValue(inspection());
    await show(project());

    expect(label()).toBe('main');
  });

  /**
   * The report this file exists for: the folder is a checkout that has since been moved onto
   * another branch, and the chip used to answer with the branch the session RECORDED.
   */
  it('names the branch the folder is really on, not the one the session recorded', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'fix/scrub-missing-knowledge-ids' }));
    await show(project({ branch: 'main' }));

    expect(label()).toBe('fix/scrub-missing-knowledge-ids');
  });

  it('reads HEAD from the worktree once the session runs in one', async () => {
    inspectProject.mockImplementation(async (directory: string) =>
      directory === WORKTREE
        ? inspection({ directory: WORKTREE, currentBranch: 'feat/chips' })
        : inspection({ currentBranch: 'main' })
    );
    await show(project({ branch: 'feat/chips', workspace: true, workingDirectory: WORKTREE }));

    expect(label()).toBe('feat/chips');
  });

  it('admits a detached HEAD rather than naming the recorded branch', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: null }));
    await show(project({ branch: 'main' }));

    expect(label()).toBe('no branch');
  });

  /**
   * A worktree container answers git for the BARE repo and is refused as a project, so the one
   * way a session is still bound to one is from before that refusal existed. It must not then
   * put up the recorded branch as though something had checked it out.
   */
  it('names no branch for a folder git reports as no repository', async () => {
    inspectProject.mockResolvedValue(
      inspection({ directory: CONTAINER, isRepository: false, branches: [], currentBranch: null })
    );
    await show(project({ directory: CONTAINER, workingDirectory: CONTAINER, branch: 'main' }));

    expect(label()).toBe('no branch');
  });

  it('says in the menu that picking a branch checks it out while the toggle is off', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'fix/elsewhere' }));
    await show(project());

    await act(async () => {
      (host.querySelector('[data-testid="session-chip-branch-btn"]') as HTMLElement).click();
    });
    const notice = document.body.querySelector('[data-testid="session-chip-branch-notice"]')?.textContent ?? '';
    expect(notice).toMatch(/checks it out in/i);
    expect(notice).not.toMatch(/nothing is checked out/i);
  });

  /**
   * The reported bug, on a new session: with the toggle off the pick is a checkout, and the
   * chip has to name the new branch as soon as the pick resolves - not on the next focus.
   */
  it('names the picked branch right after a toggle-off pick checks it out', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    const setBranch = vi.fn(async () => {
      inspectProject.mockResolvedValue(inspection({ currentBranch: 'feat/chips' }));
    });
    await act(async () =>
      root.render(<SessionChips project={project()} binding={{ ...binding, setBranch }} settledTurns={0} />)
    );
    await act(async () => undefined);
    expect(label()).toBe('main');

    await act(async () => {
      (host.querySelector('[data-testid="session-chip-branch-btn"]') as HTMLElement).click();
    });
    const option = [...document.body.querySelectorAll('[data-testid="session-chip-branch-option"]')].find(
      node => node.textContent === 'feat/chips'
    ) as HTMLElement;
    await act(async () => option.click());
    await act(async () => undefined);

    expect(setBranch).toHaveBeenCalledWith('feat/chips');
    expect(label()).toBe('feat/chips');
  });

  /** Before git answers the list is empty, which must not read as "the pick is a new name". */
  it('does not call an existing pick new while the branch list is still being read', async () => {
    inspectProject.mockImplementation(() => new Promise<ProjectInspection>(() => undefined));
    await show(project({ branch: 'feat/chips', workspace: true }));

    const button = host.querySelector('[data-testid="session-chip-branch-btn"]') as HTMLElement;
    await act(async () => {
      button.parentElement?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // Joy's Tooltip opens after its enter delay (100ms).
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    const tooltip = document.body.querySelector('[role="tooltip"]')?.textContent ?? '';
    expect(tooltip).toMatch(/cut from feat\/chips/i);
    expect(tooltip).not.toMatch(/are created/i);
  });

  it('shows the picked base before the first message when the worktree toggle is on', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project({ branch: 'feat/chips', workspace: true }));

    expect(label()).toBe('feat/chips');
  });

  /** HEAD moves from a terminal, and the chip is read after the user comes back to the window. */
  it('re-reads HEAD when the window regains focus', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project());
    expect(label()).toBe('main');

    inspectProject.mockResolvedValue(inspection({ currentBranch: 'feat/chips' }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => undefined);

    expect(label()).toBe('feat/chips');
  });

  /**
   * The case focus cannot catch: the agent's own `git switch` moves HEAD without the window
   * ever being blurred, so the reading has to be re-taken when the reply that ran it ends.
   */
  it('re-reads HEAD when a reply ends', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project());
    expect(label()).toBe('main');

    inspectProject.mockResolvedValue(inspection({ currentBranch: 'feat/chips' }));
    await show(project(), 1);

    expect(label()).toBe('feat/chips');
  });

  /** A re-read is a trigger, not a poll: an idle chip asks git nothing after its first answer. */
  it('asks git nothing while nothing has happened', async () => {
    inspectProject.mockResolvedValue(inspection());
    await show(project());
    const asked = inspectProject.mock.calls.length;

    await show(project(), 0);
    await act(async () => undefined);

    expect(inspectProject.mock.calls.length).toBe(asked);
  });

  /**
   * A recorded branch is not evidence of a checkout: when HEAD did not move, a re-read must
   * answer with the branch the folder is still on - never with the one the session recorded.
   */
  it('keeps naming the checked-out branch when a re-read follows a recorded-only pick', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project({ branch: 'main' }));

    await show(project({ branch: 'feat/chips' }), 1);

    expect(label()).toBe('main');
  });

  /**
   * The race the `of === key` guard exists for, now that a second trigger can start a read:
   * a reading begun before a move must not land on the folders it was not taken in.
   */
  it('drops a re-read that a later move has overtaken', async () => {
    let release: (value: ProjectInspection) => void = () => undefined;
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project());
    expect(label()).toBe('main');

    inspectProject.mockImplementation(
      async () =>
        await new Promise<ProjectInspection>(resolve => {
          release = resolve;
        })
    );
    await act(async () => {
      root.render(<SessionChips project={project()} binding={binding} settledTurns={1} />);
    });

    inspectProject.mockResolvedValue(inspection({ directory: WORKTREE, currentBranch: 'feat/chips' }));
    await show(project({ branch: 'feat/chips', workspace: true, workingDirectory: WORKTREE }), 1);
    expect(label()).toBe('feat/chips');

    await act(async () => {
      release(inspection({ currentBranch: 'main' }));
    });

    expect(label()).toBe('feat/chips');
  });
});

/**
 * A session that has run commands in one folder must not be repointed at another: the transcript
 * above would then describe work done somewhere the session no longer claims. The lock is on
 * first use rather than on creation, so a user who picked the wrong folder can still fix it.
 */
describe('the chip row once the session has run here', () => {
  let host: HTMLDivElement;
  let root: Root;
  const inspectProject = vi.fn();

  async function show(inUse: boolean): Promise<void> {
    await act(async () =>
      root.render(<SessionChips project={project()} binding={binding} settledTurns={0} inUse={inUse} />)
    );
    await act(async () => undefined);
  }

  /** Joy puts `disabled` on the control it renders inside the chip, not on the tagged node. */
  const disabled = (testid: string): boolean => {
    const node = host.querySelector(`[data-testid="${testid}"]`);
    if (!node) throw new Error(`no ${testid} in the row`);
    return node.hasAttribute('disabled') || !!node.querySelector('button[disabled], input[disabled]');
  };

  beforeEach(() => {
    inspectProject.mockReset();
    inspectProject.mockResolvedValue(inspection());
    (window as unknown as { b4m: unknown }).b4m = { chat: { inspectProject, listRecentFolders }, getAppInfo };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('leaves every control editable while nothing has run yet', async () => {
    await show(false);

    expect(disabled('session-chip-project')).toBe(false);
    expect(disabled('session-chip-worktree-toggle')).toBe(false);
    expect(disabled('session-chip-add-context')).toBe(false);
  });

  it('locks the folder, worktree and context controls once it has', async () => {
    await show(true);

    expect(disabled('session-chip-project')).toBe(true);
    expect(disabled('session-chip-worktree-toggle')).toBe(true);
    expect(disabled('session-chip-add-context')).toBe(true);
  });

  it('leaves the branch chip openable while nothing has run yet', async () => {
    await show(false);

    expect(disabled('session-chip-branch-btn')).toBe(false);
  });

  /** A lock, not a blank: the label still says which branch, and the menu no longer opens. */
  it('disables the branch chip after the first message so its menu cannot be opened', async () => {
    await show(true);

    const button = host.querySelector('[data-testid="session-chip-branch-btn"]') as HTMLElement;
    expect(button.textContent).toBe('main');
    expect(disabled('session-chip-branch-btn')).toBe(true);

    await act(async () => button.click());
    expect(document.body.querySelector('[data-testid="session-chip-branch-option"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="session-chip-branch-notice"]')).toBeNull();
  });

  /** The report this guards: the path and the reason ran together as one line off the window. */
  it('shows the locked folder reason with the path on a line of its own', async () => {
    await show(true);

    const chip = host.querySelector('[data-testid="session-chip-project"]') as HTMLElement;
    await act(async () => {
      chip.parentElement?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // Joy's Tooltip opens after its enter delay (100ms).
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    const tooltip = document.body.querySelector('[role="tooltip"]') as HTMLElement;

    expect(tooltip.textContent?.split('\n')).toEqual([expect.stringMatching(/new session/i), CHECKOUT]);
    expect(getComputedStyle(tooltip).whiteSpace).toBe('pre-line');
  });
});

describe('a branch another worktree has checked out', () => {
  let host: HTMLDivElement;
  let root: Root;
  const inspectProject = vi.fn();
  const HELD = `${CHECKOUT}/.claude/worktrees/feat-held`;

  async function show(bound: ChatProject, over: Partial<ProjectBindingController> = {}): Promise<void> {
    await act(async () =>
      root.render(<SessionChips project={bound} binding={{ ...binding, ...over }} settledTurns={0} />)
    );
    await act(async () => undefined);
  }

  async function openMenu(): Promise<void> {
    await act(async () => {
      (host.querySelector('[data-testid="session-chip-branch-btn"]') as HTMLElement).click();
    });
  }

  const option = (name: string): HTMLElement =>
    [...document.body.querySelectorAll('[data-testid="session-chip-branch-option"]')].find(
      node => node.querySelector('[data-testid="session-chip-branch-name"]')?.textContent?.replace(/^\* /, '') === name
    ) as HTMLElement;

  const mark = (name: string): string | undefined =>
    option(name)?.querySelector('[data-testid="session-chip-branch-elsewhere-label"]')?.textContent ?? undefined;

  async function hoverMark(name: string): Promise<string> {
    const node = option(name).querySelector('[data-testid="session-chip-branch-elsewhere-label"]') as HTMLElement;
    await act(async () => {
      node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    return [...document.body.querySelectorAll('[role="tooltip"]')].map(tip => tip.textContent).join('\n');
  }

  beforeEach(() => {
    inspectProject.mockReset();
    inspectProject.mockResolvedValue(
      inspection({
        branches: ['main', 'feat/held', 'feat/free'],
        checkedOutElsewhere: { 'feat/held': { path: HELD } },
      })
    );
    (window as unknown as { b4m: unknown }).b4m = { chat: { inspectProject, listRecentFolders }, getAppInfo };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('marks it with the path, shortened against the project, and leaves it selectable', async () => {
    await show(project());
    await openMenu();

    expect(mark('feat/held')).toBe('feat-held');
    expect(mark('feat/free')).toBeUndefined();
    expect(option('feat/held').getAttribute('aria-disabled')).not.toBe('true');
    expect(await hoverMark('feat/held')).toContain(HELD);
  });

  it('keeps the menu a set width however long the names, with the full text one hover away', async () => {
    const longBranch = `agent/${'bedrock-global-routing-'.repeat(8)}end`;
    const longPath = `${CHECKOUT}/.claude/worktrees/${'deeply-nested-'.repeat(10)}held`;
    inspectProject.mockResolvedValue(
      inspection({
        branches: ['main', longBranch, ...Array.from({ length: 10 }, (_, i) => `feat/${i}`)],
        checkedOutElsewhere: { [longBranch]: { path: longPath } },
      })
    );
    await show(project());
    await openMenu();

    const menu = document.body.querySelector('[data-testid="session-chip-branch-menu"]') as HTMLElement;
    const style = getComputedStyle(menu);
    expect(style.width).toBe('380px');
    expect(style.maxWidth).toBe('calc(100vw - 32px)');
    expect(style.minWidth).not.toBe('280px');

    const name = option(longBranch).querySelector('[data-testid="session-chip-branch-name"]') as HTMLElement;
    expect(name.getAttribute('title')).toBe(longBranch);
    expect(mark(longBranch)).toBe(`${'deeply-nested-'.repeat(10)}held`);
    expect(await hoverMark(longBranch)).toContain(longPath);
  });

  it('lists a branch named like an Object member without marking it', async () => {
    inspectProject.mockResolvedValue(
      inspection({ branches: ['main', 'constructor'], checkedOutElsewhere: { 'feat/held': { path: HELD } } })
    );
    await show(project());
    await openMenu();

    expect(option('constructor')).toBeDefined();
    expect(mark('constructor')).toBeUndefined();
  });

  it('does not make the mark read as a problem with the toggle on', async () => {
    await show(project({ workspace: true }));
    await openMenu();

    const tip = await hoverMark('feat/held');
    expect(tip).toMatch(/only the base/i);
    expect(tip).not.toMatch(/offers to/i);
  });

  it('does not mark the worktree the session itself runs in', async () => {
    inspectProject.mockImplementation(async (directory: string) =>
      directory === WORKTREE
        ? inspection({ directory: WORKTREE, currentBranch: 'b4m/own' })
        : inspection({
            branches: ['main', 'b4m/own'],
            checkedOutElsewhere: { 'b4m/own': { path: WORKTREE } },
          })
    );
    await show(project({ workspace: true, workspaceBranch: 'b4m/own', workingDirectory: WORKTREE }));
    await openMenu();

    expect(mark('b4m/own')).toBeUndefined();
  });

  it('offers both ways on when main refuses a toggle-off pick, and uses the checkout', async () => {
    const moveToCheckout = vi.fn();
    const elsewhere = { branch: 'feat/held', path: HELD };
    await show(project(), {
      moveToCheckout,
      error: { message: `feat/held is already checked out in ${HELD}.`, busy: false, elsewhere },
    });

    expect(host.querySelector('[data-testid="session-chip-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-chip-elsewhere-message"]')?.textContent).toContain(HELD);
    await act(async () => {
      (host.querySelector('[data-testid="session-chip-elsewhere-use-btn"]') as HTMLElement).click();
    });

    expect(moveToCheckout).toHaveBeenCalledWith(elsewhere);
  });

  it('turns the toggle on with that branch as the base when a worktree is chosen', async () => {
    const worktreeFrom = vi.fn();
    await show(project(), {
      worktreeFrom,
      error: { message: 'held', busy: false, elsewhere: { branch: 'feat/held', path: HELD } },
    });

    await act(async () => {
      (host.querySelector('[data-testid="session-chip-elsewhere-worktree-btn"]') as HTMLElement).click();
    });

    expect(worktreeFrom).toHaveBeenCalledWith('feat/held');
  });

  it('offers only the worktree when the holding folder is gone', async () => {
    await show(project(), {
      error: { message: 'gone', busy: false, elsewhere: { branch: 'feat/held', path: HELD, prunable: true } },
    });

    expect(host.querySelector('[data-testid="session-chip-elsewhere-use-btn"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-chip-elsewhere-worktree-btn"]')).not.toBeNull();
  });

  it('leaves any other refusal as the plain notice', async () => {
    await show(project(), { error: { message: 'Could not switch: nope', busy: false } });

    expect(host.querySelector('[data-testid="session-chip-error"]')?.textContent).toBe('Could not switch: nope');
    expect(host.querySelector('[data-testid="session-chip-elsewhere"]')).toBeNull();
  });
});

describe("the folder chip's recent folders", () => {
  let host: HTMLDivElement;
  let root: Root;
  const inspectProject = vi.fn();
  const listRecent = vi.fn();
  const removeRecentFolder = vi.fn();
  const pickDirectory = vi.fn();
  const chooseDirectory = vi.fn();
  const OTHER = '/Users/someone/elsewhere/thing';

  const recent: RecentFolder[] = [
    { path: CHECKOUT, name: 'main' },
    { path: OTHER, name: 'thing' },
  ];

  const inMenu = (testid: string): HTMLElement[] =>
    Array.from(document.body.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`));

  async function show(bound: ChatProject | null): Promise<void> {
    await act(async () =>
      root.render(
        <SessionChips project={bound} binding={{ ...binding, pickDirectory, chooseDirectory }} settledTurns={0} />
      )
    );
    await act(async () => undefined);
  }

  async function openMenu(): Promise<void> {
    await act(async () => (host.querySelector('[data-testid="session-chip-project"]') as HTMLElement).click());
    await act(async () => undefined);
  }

  beforeEach(() => {
    for (const mock of [inspectProject, listRecent, removeRecentFolder, pickDirectory, chooseDirectory])
      mock.mockReset();
    inspectProject.mockResolvedValue(inspection());
    listRecent.mockResolvedValue(recent);
    (window as unknown as { b4m: unknown }).b4m = {
      chat: { inspectProject, listRecentFolders: listRecent, removeRecentFolder },
      getAppInfo,
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('lists recent folders by name, ticks the current one, and ends with Open folder', async () => {
    await show(project());
    await openMenu();

    const items = inMenu('session-chip-project-recent');
    expect(items.map(item => item.textContent)).toEqual(['main', 'thing']);
    expect(
      items.map(item => item.getAttribute('aria-selected') === 'true' || item.classList.contains('Mui-selected'))
    ).toEqual([true, false]);
    expect(inMenu('session-chip-project-recent-heading')[0]?.textContent).toBe('Recent');
    expect(inMenu('session-chip-project-open-folder')[0]?.textContent).toBe('Open folder...');
  });

  it('binds a recent folder directly, without the picker', async () => {
    await show(project());
    await openMenu();

    await act(async () => inMenu('session-chip-project-recent')[1].click());

    expect(chooseDirectory).toHaveBeenCalledWith(OTHER);
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('does not re-bind the folder the session is already in', async () => {
    await show(project());
    await openMenu();

    await act(async () => inMenu('session-chip-project-recent')[0].click());

    expect(chooseDirectory).not.toHaveBeenCalled();
  });

  it('opens the OS picker from Open folder', async () => {
    await show(project());
    await openMenu();

    await act(async () => inMenu('session-chip-project-open-folder')[0].click());

    expect(pickDirectory).toHaveBeenCalledTimes(1);
  });

  it('forgets an entry without choosing it', async () => {
    removeRecentFolder.mockResolvedValue([recent[0]]);
    await show(project());
    await openMenu();

    await act(async () => inMenu('session-chip-project-recent-remove-btn')[1].click());

    expect(removeRecentFolder).toHaveBeenCalledWith(OTHER);
    expect(chooseDirectory).not.toHaveBeenCalled();
    expect(inMenu('session-chip-project-recent').map(item => item.textContent)).toEqual(['main']);
  });

  it('forgets the focused entry on Delete without choosing it', async () => {
    removeRecentFolder.mockResolvedValue([recent[0]]);
    await show(project());
    await openMenu();

    await act(async () => {
      inMenu('session-chip-project-recent')[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      );
    });

    expect(removeRecentFolder).toHaveBeenCalledWith(OTHER);
    expect(chooseDirectory).not.toHaveBeenCalled();
  });

  it('shows the full path on hover, so folders with the same name can be told apart', async () => {
    await show(project());
    await openMenu();

    await act(async () => {
      inMenu('session-chip-project-recent')[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    const tooltips = Array.from(document.body.querySelectorAll('[role="tooltip"]')).map(node => node.textContent);
    expect(tooltips).toContain(OTHER);
  });

  it('offers only Open folder when there are no recent folders', async () => {
    listRecent.mockResolvedValue([]);
    await show(null);
    await openMenu();

    expect(inMenu('session-chip-project-recent')).toHaveLength(0);
    expect(inMenu('session-chip-project-recent-heading')).toHaveLength(0);
    expect(inMenu('session-chip-project-open-folder')).toHaveLength(1);
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  /** The reported bug: the first pick was recorded, but the chip kept going to Finder. */
  it('lists a folder recorded after the chip mounted the next time it opens', async () => {
    listRecent.mockResolvedValueOnce([]).mockResolvedValue([recent[1]]);
    await show(null);
    await openMenu();

    expect(inMenu('session-chip-project-recent').map(item => item.textContent)).toEqual(['thing']);
  });
});
