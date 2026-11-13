import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { EMPTY_WATCH_SNAPSHOT } from '@shared/watch';
import { trayPresentation, type TrayPresentation } from './trayPresentation';

const electron = vi.hoisted(() => ({
  trays: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  templates: [] as MenuItemConstructorOptions[][],
  menuListeners: [] as Array<() => void>,
}));

vi.mock('electron', () => ({
  Tray: vi.fn(function Tray() {
    const tray = {
      setImage: vi.fn(),
      setTitle: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      popUpContextMenu: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
    };
    electron.trays.push(tray);
    return tray;
  }),
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      electron.templates.push(template);
      return { on: (_event: string, listener: () => void) => electron.menuListeners.push(listener) };
    },
  },
}));

const { createTrayController } = await import('./tray');

const images = { idle: 'idle', working: 'working', 'needs-you': 'needs-you', done: 'done' } as never;

const needsYou: TrayPresentation = trayPresentation(
  {
    overall: 'needs-you',
    needsYouCount: 2,
    orchestrations: [
      {
        rootId: 'root',
        title: 'Root',
        agents: [{ id: 'a', title: 'Tests', state: 'needs-you', activity: null }],
        sessions: [],
        statuses: {},
        activity: {},
        lastActiveAt: 0,
        needsYouSince: 1,
        celebrate: false,
      },
    ],
    pending: [
      {
        approvalId: 'quick-1',
        sessionId: 'a',
        rootId: 'root',
        agentTitle: 'Tests',
        orchestrationTitle: 'Root',
        summary: 'bash ls',
        quick: true,
        since: 1,
      },
      {
        approvalId: 'risky-1',
        sessionId: 'a',
        rootId: 'root',
        agentTitle: 'Tests',
        orchestrationTitle: 'Root',
        summary: 'bash rm -rf build',
        quick: false,
        since: 2,
      },
    ],
  },
  false
);

function setup() {
  electron.trays.length = 0;
  electron.templates.length = 0;
  electron.menuListeners.length = 0;
  const handlers = { respond: vi.fn(), focus: vi.fn(), action: vi.fn(), menuOpened: vi.fn() };
  const controller = createTrayController(images, handlers);
  controller.render(needsYou);
  const template = () => electron.templates.at(-1) ?? [];
  const byLabel = (items: MenuItemConstructorOptions[], label: string) => items.find(item => item.label === label);
  const click = (item: MenuItemConstructorOptions | undefined) =>
    (item?.click as unknown as (() => void) | undefined)?.();
  return { handlers, controller, tray: electron.trays[0], template, byLabel, click };
}

describe('createTrayController', () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('shows the state icon and the needs-you words on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { tray } = setup();
    expect(tray.setImage).toHaveBeenLastCalledWith('needs-you');
    expect(tray.setTitle).toHaveBeenLastCalledWith('2 need you');
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Bike4Mind - 2 need you');
  });

  it('approves once and denies through the handlers', () => {
    const { handlers, template, byLabel, click } = setup();
    const approval = byLabel(template(), 'Tests: bash ls');
    const submenu = approval?.submenu as MenuItemConstructorOptions[];
    click(byLabel(submenu, 'Approve once'));
    click(byLabel(submenu, 'Deny'));
    expect(handlers.respond).toHaveBeenNthCalledWith(1, 'quick-1', 'once');
    expect(handlers.respond).toHaveBeenNthCalledWith(2, 'quick-1', 'deny');
  });

  it('sends a request that needs the full card to the app instead', () => {
    const { handlers, template, byLabel, click } = setup();
    const submenu = byLabel(template(), 'Tests: bash rm -rf build')?.submenu as MenuItemConstructorOptions[];
    expect(byLabel(submenu, 'Approve once')).toBeUndefined();
    click(submenu.find(item => item.label?.startsWith('Review in Bike4Mind')));
    expect(handlers.focus).toHaveBeenCalledWith({ sessionId: 'a', rootId: 'root' });
    expect(handlers.respond).not.toHaveBeenCalled();
  });

  it('focuses an agent from its orchestration, and runs the actions', () => {
    const { handlers, template, byLabel, click } = setup();
    const submenu = byLabel(template(), 'Root')?.submenu as MenuItemConstructorOptions[];
    click(submenu[0]);
    expect(handlers.focus).toHaveBeenCalledWith({ sessionId: 'a', rootId: 'root' });
    click(byLabel(template(), 'Show mini Tavern'));
    click(byLabel(template(), 'Hide menu-bar item'));
    expect(handlers.action).toHaveBeenNthCalledWith(1, 'toggle-mini');
    expect(handlers.action).toHaveBeenNthCalledWith(2, 'hide-tray');
  });

  it('acknowledges when the menu opens', () => {
    const { handlers } = setup();
    electron.menuListeners.at(-1)?.();
    expect(handlers.menuOpened).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild the menu for an unchanged presentation', () => {
    const { controller } = setup();
    controller.render(needsYou);
    expect(electron.templates).toHaveLength(1);
    controller.render(trayPresentation(EMPTY_WATCH_SNAPSHOT, false));
    expect(electron.templates).toHaveLength(2);
  });

  it('sets no title outside macOS, and opens the menu on a left click there', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { tray } = setup();
    expect(tray.setTitle).not.toHaveBeenCalled();
    expect(tray.on).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('removes the item on destroy', () => {
    const { controller, tray } = setup();
    controller.destroy();
    expect(tray.destroy).toHaveBeenCalled();
  });
});
