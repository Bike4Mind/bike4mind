import { Menu, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { AttentionOpenEvent } from '@shared/attention';
import type { WatchOverall } from '@shared/watch';
import type { TrayAction, TrayMenuItem, TrayPresentation } from './trayPresentation';

export type TrayHandlers = {
  respond(approvalId: string, decision: 'once' | 'deny'): void;
  focus(open: AttentionOpenEvent): void;
  action(action: TrayAction): void;
  /** The menu is about to show: the user is looking, so finished work is acknowledged. */
  menuOpened(): void;
};

export interface TrayController {
  render(presentation: TrayPresentation): void;
  destroy(): void;
}

function menuItem(item: TrayMenuItem, handlers: TrayHandlers): MenuItemConstructorOptions {
  switch (item.kind) {
    case 'header':
      return { label: item.label, enabled: false };
    case 'separator':
      return { type: 'separator' };
    case 'action':
      return { label: item.label, click: () => handlers.action(item.action) };
    case 'approval': {
      const open = () => handlers.focus({ sessionId: item.sessionId, rootId: item.rootId });
      const submenu: MenuItemConstructorOptions[] = item.quick
        ? [
            { label: 'Approve once', click: () => handlers.respond(item.approvalId, 'once') },
            { label: 'Deny', click: () => handlers.respond(item.approvalId, 'deny') },
            { type: 'separator' },
            { label: 'Open in Bike4Mind', click: open },
          ]
        : [
            { label: 'Needs a closer look in the app', enabled: false },
            { label: 'Review in Bike4Mind\u2026', click: open },
          ];
      return { label: item.label, submenu };
    }
    case 'orchestration': {
      const openRoot = () => handlers.focus({ sessionId: item.rootId, rootId: item.rootId });
      const agents: MenuItemConstructorOptions[] = item.agents.map(agent => ({
        label: agent.label,
        click: () => handlers.focus({ sessionId: agent.sessionId, rootId: item.rootId }),
      }));
      return {
        label: item.label,
        submenu: [
          ...agents,
          ...(agents.length > 0 ? [{ type: 'separator' as const }] : []),
          { label: 'Open in Tavern', click: openRoot },
        ],
      };
    }
  }
}

/**
 * The menu-bar item: a template icon for the overall state, words only while someone needs you,
 * and a menu rebuilt from each presentation. `images` maps each state to its icon.
 */
export function createTrayController(
  images: Record<WatchOverall, NativeImage>,
  handlers: TrayHandlers
): TrayController {
  const tray = new Tray(images.idle);
  let lastKey = '';

  // macOS opens the context menu on any click; Windows and Linux only on a right click.
  if (process.platform !== 'darwin') tray.on('click', () => tray.popUpContextMenu());

  return {
    render(presentation) {
      const key = JSON.stringify(presentation);
      if (key === lastKey) return;
      lastKey = key;
      tray.setImage(images[presentation.icon]);
      if (process.platform === 'darwin') tray.setTitle(presentation.title);
      tray.setToolTip(presentation.tooltip);
      const menu = Menu.buildFromTemplate(presentation.items.map(item => menuItem(item, handlers)));
      menu.on('menu-will-show', () => handlers.menuOpened());
      tray.setContextMenu(menu);
    },
    destroy() {
      tray.destroy();
    },
  };
}
