import type { DismissedUpdateMemory } from './DismissedUpdatePreference';
import {
  initialUpdateState,
  isBusy,
  reduceUpdate,
  type UpdateBusyReport,
  type UpdateEvent,
  type UpdateInstallResult,
  type UpdateState,
} from '@shared/update';

/** The part of electron-updater this service uses, named so a test can stand in for it. */
export interface UpdaterPort {
  check(): Promise<void>;
  download(): Promise<void>;
  /** Hands the app to the installer. Nothing runs after this. */
  install(): void;
}

export interface UpdateServiceDeps {
  currentVersion: string;
  /** null when this build has no feed configured, or is not packaged. Updates are then off. */
  updater: UpdaterPort | null;
  /** What the app is in the middle of, asked fresh at the moment an install is requested. */
  busy: () => UpdateBusyReport;
  /** Graceful teardown of background processes and MCP children, before the app is handed over. */
  prepareQuit: () => Promise<void>;
  onChanged: (state: UpdateState) => void;
  /** Where a version's release notes live, or null when the feed has no known notes page. */
  releaseUrl?: (version: string) => string | null;
  /** Remembers the version whose notice the user closed, across launches. */
  dismissed?: DismissedUpdateMemory;
  /** Failures nobody is shown still get a line here. */
  log?: (message: string) => void;
}

/**
 * Owns the update state and the three things the user can ask for: check, download, install.
 *
 * Nothing here throws at a caller. A check that cannot reach the feed, a download that dies
 * halfway and a manifest that does not parse all land as 'unreachable', because none of them is
 * a problem the user can act on and an update is not why they opened the app. The only failure
 * that IS surfaced is the one that blocks something they explicitly asked for - an install with
 * work still in flight - and that comes back as a value, not an exception.
 */
export class UpdateService {
  private state: UpdateState;
  /** Guards the one operation that must not overlap itself. */
  private inFlight = false;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.state = initialUpdateState(deps.currentVersion, deps.updater !== null);
  }

  snapshot(): UpdateState {
    const version = this.state.version;
    return { ...this.state, releaseUrl: version && this.deps.releaseUrl ? this.deps.releaseUrl(version) : null };
  }

  /** Load the persisted dismissal. A missing or unreadable file is "nothing dismissed". */
  async restoreDismissed(): Promise<void> {
    const version = await this.deps.dismissed?.read().catch(() => null);
    if (!version || version === this.state.dismissedVersion) return;
    this.state = { ...this.state, dismissedVersion: version };
    this.deps.onChanged(this.snapshot());
  }

  /**
   * Hide the notice for this version only. Applied before it is written, so a disk that will not
   * take the file still closes the notice for this run.
   */
  async dismiss(version: string): Promise<void> {
    const dismissed = version.trim();
    if (!dismissed || dismissed === this.state.dismissedVersion) return;
    this.state = { ...this.state, dismissedVersion: dismissed };
    this.deps.onChanged(this.snapshot());
    try {
      await this.deps.dismissed?.record(dismissed);
    } catch (error) {
      this.deps.log?.(`[update] could not persist dismissed version: ${errorMessage(error)}`);
    }
  }

  /** Fold an event in and push the result, but only when it actually changed something. */
  apply(event: UpdateEvent): void {
    const next = reduceUpdate(this.state, event);
    if (next === this.state) return;
    this.state = next;
    this.deps.onChanged(this.snapshot());
  }

  /**
   * Ask the feed. Safe to call on a timer, on launch and from a button at once - a check
   * already running is simply not started twice.
   */
  async check(): Promise<void> {
    if (!this.deps.updater || this.inFlight) return;
    if (this.state.status === 'downloading' || this.state.status === 'ready') return;

    this.inFlight = true;
    this.apply({ type: 'check-started' });
    try {
      // The outcome arrives as an event from the updater, not as this promise's value: it is
      // the same path a check started by the timer takes, so there is one place it is handled.
      await this.deps.updater.check();
    } catch (error) {
      this.deps.log?.(`[update] check failed: ${errorMessage(error)}`);
      this.apply({ type: 'unreachable' });
    } finally {
      this.inFlight = false;
    }
  }

  async download(): Promise<void> {
    if (!this.deps.updater || this.inFlight) return;
    if (this.state.status !== 'available') return;

    this.inFlight = true;
    this.apply({ type: 'download-started' });
    try {
      await this.deps.updater.download();
    } catch (error) {
      this.deps.log?.(`[update] download failed: ${errorMessage(error)}`);
      this.apply({ type: 'download-failed' });
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Restart into the new version - the only path that ends this process on purpose.
   *
   * `force` is the user answering the question this returns. Without it, an install while a
   * reply is streaming or a dev server is up comes back as 'busy' and NOTHING happens: a Code
   * session mid-turn has an abort controller, an unresolved promise and a process group behind
   * it, and none of that survives a quit. Which of those matters is the user's call, so this
   * reports and waits rather than deciding.
   */
  async install(force: boolean): Promise<UpdateInstallResult> {
    if (!this.deps.updater || this.state.status !== 'ready') return { ok: false, reason: 'not-ready' };

    const busy = this.deps.busy();
    if (!force && isBusy(busy)) return { ok: false, reason: 'busy', busy };

    // Children are killed here rather than left to the quit handlers: quitAndInstall hands the
    // app to the installer, and a dev server still holding a port through that is exactly the
    // orphan the background registry exists to prevent.
    await this.deps.prepareQuit().catch(() => undefined);
    this.deps.updater.install();
    return { ok: true };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
