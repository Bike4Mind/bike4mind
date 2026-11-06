import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, powerMonitor, powerSaveBlocker } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { LoopApproveRequest, LoopApproveResult, LoopRunnerSettings, LoopRunnerState } from '@shared/loopRunner';
import type { AuthService } from '../auth/AuthService';
import type { ChatService } from '../chat/ChatService';
import type { BackgroundProcessRegistry } from '../chat/tools/BackgroundProcessRegistry';
import { createMainLogger } from '../logger';
import { runGh } from '../pr/gh';
import { PrGithub } from '../pr/github';
import { privateFile } from '../privateFile';
import { appWindows } from '../windows';
import { sampleMachine } from './budget';
import { repoSlug } from './guards';
import { HttpLoopRunnerClient } from './LoopRunnerClient';
import { LoopPolicyStore } from './LoopPolicyStore';
import { LoopRunner } from './LoopRunner';

function originOf(directory: string): Promise<string> {
  return new Promise(resolve =>
    execFile('git', ['remote', 'get-url', 'origin'], { cwd: directory, timeout: 5_000 }, (error, stdout) =>
      resolve(error ? '' : stdout)
    )
  );
}

/**
 * Settings > Loop runner, and the runner behind it. Call after registerChat, passing the runner's
 * `unattended` and `merge` through registerChat's loop hooks.
 */
export function registerLoopRunner(auth: AuthService, chat: ChatService, background: BackgroundProcessRegistry) {
  const logger = createMainLogger(process.env.B4M_DESKTOP_VERBOSE === '1');
  const store = new LoopPolicyStore(privateFile(join(app.getPath('userData'), 'loop-runner.json')));
  const github = new PrGithub(runGh);
  const environment = () => {
    const state = auth.getState();
    return state.status === 'signed-in' ? { key: state.environment.url, url: state.environment.url } : null;
  };

  const state = async (): Promise<LoopRunnerState> => {
    const env = environment();
    const key = env?.key ?? auth.getState().environment.url;
    const [settings, policies] = await Promise.all([store.settings(key), store.policies(key)]);
    return {
      signedIn: env !== null,
      server: env?.url ?? null,
      settings,
      openAtLogin: app.getLoginItemSettings().openAtLogin,
      policies,
      ...runner.state(),
    };
  };
  const push = () => {
    void state().then(next => {
      for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.loopRunnerStateChanged, next);
    });
  };

  const runner = new LoopRunner({
    client: new HttpLoopRunnerClient(() => auth.getApiClient()),
    chat,
    killSessionProcesses: sessionId => background.killSession(sessionId),
    store,
    environment,
    // ponytail: the home volume stands in for every repo's .b4m/worktrees; per-repo statfs if they differ.
    sample: () => sampleMachine(homedir(), powerMonitor),
    gh: runGh,
    github,
    powerSaveBlocker,
    focused: () => BrowserWindow.getFocusedWindow() !== null,
    onChange: push,
    logger,
  });

  /** Follow the toggle for whichever environment is signed in now. */
  const sync = async () => {
    const env = environment();
    if (env && (await store.settings(env.key)).enabled) runner.start();
    else runner.stop();
    push();
  };

  ipcMain.handle(IPC_CHANNELS.loopRunnerGetState, () => state());
  ipcMain.handle(IPC_CHANNELS.loopRunnerSetSettings, async (_event, patch: Partial<LoopRunnerSettings>) => {
    const env = environment();
    if (!env) return state();
    const clean: Partial<LoopRunnerSettings> = {};
    if (typeof patch?.enabled === 'boolean') clean.enabled = patch.enabled;
    if (typeof patch?.runOnBattery === 'boolean') clean.runOnBattery = patch.runOnBattery;
    if (typeof patch?.runWhenBusy === 'boolean') clean.runWhenBusy = patch.runWhenBusy;
    if (patch && 'laneCap' in patch) {
      clean.laneCap = Number.isInteger(patch.laneCap) && (patch.laneCap as number) >= 1 ? patch.laneCap : undefined;
    }
    await store.setSettings(env.key, clean);
    await sync();
    return state();
  });
  ipcMain.handle(IPC_CHANNELS.loopRunnerSetOpenAtLogin, (_event, on: unknown) => {
    app.setLoginItemSettings({ openAtLogin: on === true });
    return state();
  });
  ipcMain.handle(
    IPC_CHANNELS.loopRunnerApprove,
    async (event, request: LoopApproveRequest): Promise<LoopApproveResult> => {
      const env = environment();
      if (!env) return { ok: false, error: 'Sign in first.' };
      // The hint comes from the server's list, never from the renderer's request.
      const pending = runner.state().pendingApprovals.find(loop => loop.loopId === request?.loopId);
      if (!pending || typeof request.loopName !== 'string') return { ok: false, error: 'Unknown loop.' };
      const { repoHint } = pending;
      const window = BrowserWindow.fromWebContents(event.sender);
      const options = { title: `Folder for ${request.loopName}`, properties: ['openDirectory' as const] };
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      const directory = picked.filePaths[0];
      if (picked.canceled || !directory) return { ok: false, error: 'No folder picked.' };
      const slug = repoSlug(await originOf(directory));
      if (repoHint && slug !== repoHint.toLowerCase()) {
        return { ok: false, error: `That folder's origin is not ${repoHint}.` };
      }
      await store.approve(env.key, {
        loopId: request.loopId,
        loopName: request.loopName,
        approvalMode: request.approvalMode === 'full' ? 'full' : 'auto',
        directory,
        ...(repoHint ? { repoHint } : {}),
        ...(slug ? { repo: slug } : {}),
        approvedAt: new Date().toISOString(),
      });
      void runner.tick();
      return { ok: true, state: await state() };
    }
  );
  ipcMain.handle(IPC_CHANNELS.loopRunnerRevoke, async (_event, loopId: unknown) => {
    const env = environment();
    if (env && typeof loopId === 'string') await store.revoke(env.key, loopId);
    return state();
  });

  void sync();
  return { runner, sync };
}
