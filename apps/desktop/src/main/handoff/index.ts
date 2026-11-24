import { createHash } from 'node:crypto';
import { BrowserWindow, ipcMain, session, shell } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { isExternallyOpenable } from '@shared/externalLinks';
import { onAuthStateChanged, type AuthService } from '../auth';
import { markCompanionWindow } from '../windows';

const partitionFor = (scope: string) =>
  `persist:server-conversations-${createHash('sha256').update(scope).digest('hex')}`;

type Companion = { window: BrowserWindow; ownerScope: string };

// Server side: apps/client/pages/api/auth/desktop-web-session/{index,redeem}.ts.
const WEB_SESSION_CODE_PATH = '/api/auth/desktop-web-session';
const WEB_SESSION_REDEEM_PATH = '/api/auth/desktop-web-session/redeem';

/**
 * A single-use code that opens the companion window already signed in, so the user never runs the
 * web sign-in inside this embedded browser, where Cloudflare Turnstile can reject it outright.
 * Null when the code cannot be had; the window then falls back to the ordinary web sign-in.
 */
async function mintWebSessionCode(auth: AuthService): Promise<string | null> {
  const api = auth.getSessionBoundApiClient();
  if (!api) return null;
  try {
    const { code } = await api.post<{ code?: unknown }>(WEB_SESSION_CODE_PATH);
    return typeof code === 'string' && code.length > 0 ? code : null;
  } catch (error) {
    console.warn(
      'handoff: could not mint a web session code',
      error instanceof Error ? error.message.slice(0, 200) : 'Unknown failure'
    );
    return null;
  }
}

export function registerSessionHandoff(auth: AuthService): void {
  const currentScope = () => {
    const state = auth.getState();
    return state.status === 'signed-in' && state.user ? `${state.environment.url}:${state.user.id}` : null;
  };
  let companion: Companion | null = null;
  // Persistent storage still belongs to this account after its window closes.
  let observedAuthScope = currentScope();
  let authEpoch = 0;
  const clearing = new Map<string, Promise<void>>();
  const needsClear = new Set<string>();

  const clearOwnedPartition = (ownerScope: string): Promise<void> => {
    needsClear.add(ownerScope);
    const existing = clearing.get(ownerScope);
    if (existing) return existing;
    const pending = (async () => {
      await session.fromPartition(partitionFor(ownerScope)).clearStorageData();
      needsClear.delete(ownerScope);
    })();
    clearing.set(ownerScope, pending);
    const finished = () => {
      if (clearing.get(ownerScope) === pending) clearing.delete(ownerScope);
    };
    void pending.then(finished, (error: unknown) => {
      finished();
      console.warn(
        'handoff: could not clear server conversations storage',
        error instanceof Error ? error.message.slice(0, 200) : 'Unknown storage cleanup failure'
      );
    });
    return pending;
  };

  onAuthStateChanged(() => {
    const nextScope = currentScope();
    if (observedAuthScope === nextScope) return;
    const previousScope = observedAuthScope;
    const previousWindow = companion?.window;
    observedAuthScope = nextScope;
    authEpoch += 1;
    companion = null;
    previousWindow?.close();
    // Capture ownership before close(): Electron may synchronously emit its closed event.
    if (previousScope) void clearOwnedPartition(previousScope);
  });

  ipcMain.handle(IPC_CHANNELS.handoffOpenServerSessions, async () => {
    const state = auth.getState();
    const nextScope = currentScope();
    if (!nextScope || nextScope !== observedAuthScope) return;
    const requestedEpoch = authEpoch;
    const environmentUrl = state.environment.url;
    if (clearing.has(nextScope) || needsClear.has(nextScope)) {
      try {
        await clearOwnedPartition(nextScope);
      } catch {
        // Cleanup was logged above and stays dirty; never load the old account's stored session.
        return;
      }
    }
    if (currentScope() !== nextScope || authEpoch !== requestedEpoch) return;
    // Check after cleanup so concurrent opens waiting on one partition create only one window.
    if (companion?.ownerScope === nextScope && !companion.window.isDestroyed()) {
      companion.window.show();
      companion.window.focus();
      return;
    }
    const base = new URL(environmentUrl);
    if (
      base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    )
      return;
    const opened = new BrowserWindow({
      width: 1100,
      height: 800,
      title: 'Web conversations',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: partitionFor(nextScope),
      },
    });
    companion = { window: opened, ownerScope: nextScope };
    markCompanionWindow(opened);
    opened.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternallyOpenable(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    opened.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin === base.origin) return;
      event.preventDefault();
      if (isExternallyOpenable(url)) void shell.openExternal(url);
    });
    opened.on('closed', () => {
      if (companion?.window === opened) companion = null;
    });
    const userAgent = `${opened.webContents.getUserAgent()} B4M-Server-Conversations`;
    // Minted after the window exists so concurrent opens still share one window (checked above).
    const code = await mintWebSessionCode(auth);
    if (opened.isDestroyed() || companion?.window !== opened || currentScope() !== nextScope) return;
    if (!code) {
      await opened.loadURL(new URL('/notebooks', base).href, { userAgent });
      return;
    }
    // A POST navigation keeps the code out of the URL, history and access logs; the server answers
    // with the refresh cookie and a 303 to /notebooks.
    await opened.loadURL(new URL(WEB_SESSION_REDEEM_PATH, base).href, {
      userAgent,
      postData: [{ type: 'rawData', bytes: Buffer.from(JSON.stringify({ code })) }],
      extraHeaders: 'Content-Type: application/json',
    });
  });
}
