/**
 * What the app knows about a newer version of itself.
 *
 * The state machine lives here, apart from electron-updater, because the real update cycle is
 * not exercisable on macOS without a code-signing certificate: Squirrel.Mac refuses an unsigned
 * payload, and disabling that check would turn this into a remote code execution path. So the
 * transitions that decide what the user is shown - and, more importantly, what a failed check
 * is NOT allowed to throw away - are a pure reducer that tests can drive end to end.
 */

export type UpdateStatus =
  /** This build has no feed, or is not packaged. Terminal: nothing here ever checks. */
  | 'unsupported'
  /** Packaged with a feed, nothing asked yet. */
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  /** Downloaded and staged. The app is one user-driven restart from running it. */
  | 'ready'
  /** The last check did not reach a usable feed. Deliberately not an error the user is shown. */
  | 'unreachable';

export interface UpdateState {
  status: UpdateStatus;
  /** Always known, because it is this build's own version. Shown even when updates are off. */
  currentVersion: string;
  /** The newer version, once a check or a download has named one. */
  version: string | null;
  /** 0-100 while downloading. */
  percent: number;
  /** When a check last REACHED the feed, epoch ms. A failed check leaves it alone. */
  checkedAt: number | null;
  /** Release notes / download page for `version`, when the feed is one we know how to link to. */
  releaseUrl: string | null;
  /** The newer version the user closed the floating notice for. Persisted by main. */
  dismissedVersion: string | null;
}

export type UpdateEvent =
  | { type: 'check-started' }
  | { type: 'available'; version: string; at: number }
  | { type: 'up-to-date'; at: number }
  | { type: 'download-started' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  /**
   * The download died partway. Distinct from 'unreachable' because the outcome is different:
   * the update is still on offer and the user can press Download again, whereas a failed CHECK
   * leaves nothing to retry but the check.
   */
  | { type: 'download-failed' }
  /** No network, a feed that does not answer, or a manifest that does not parse. All the same. */
  | { type: 'unreachable' };

export function initialUpdateState(currentVersion: string, supported: boolean): UpdateState {
  return {
    status: supported ? 'idle' : 'unsupported',
    currentVersion,
    version: null,
    percent: 0,
    checkedAt: null,
    releaseUrl: null,
    dismissedVersion: null,
  };
}

/** Statuses that hold something a failed or negative check must not discard. */
const HOLDS_AN_OFFER: ReadonlySet<UpdateStatus> = new Set<UpdateStatus>(['available', 'downloading', 'ready']);

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * The whole update state machine.
 *
 * Two rules carry most of the weight:
 *
 * 1. A downloaded update survives everything. Once the status is 'ready' the bytes are on disk
 *    and the user has been offered a restart; a later check that fails, or that reports the
 *    feed rolled back, must not retract that offer - the user would be left with a staged
 *    update and no button for it.
 * 2. 'unreachable' never overwrites an offer. A laptop that goes offline an hour after an
 *    update was found still has that update waiting, and saying otherwise would be a lie the
 *    user acts on. It also leaves `checkedAt` alone, since nothing was successfully checked.
 */
export function reduceUpdate(state: UpdateState, event: UpdateEvent): UpdateState {
  // A build with no feed has nothing to report and no way to get anything wrong.
  if (state.status === 'unsupported') return state;

  switch (event.type) {
    case 'check-started':
      // Only from a resting state. Re-checking while an update is already offered or
      // downloading must not blank the row back to "Checking..." and lose the version with it.
      return state.status === 'idle' || state.status === 'up-to-date' || state.status === 'unreachable'
        ? { ...state, status: 'checking' }
        : state;

    case 'available':
      if (state.status === 'downloading' || state.status === 'ready') return state;
      return { ...state, status: 'available', version: event.version, percent: 0, checkedAt: event.at };

    case 'up-to-date':
      // Rule 1: a staged download outranks the feed changing its mind.
      if (state.status === 'ready') return { ...state, checkedAt: event.at };
      if (state.status === 'downloading') return { ...state, checkedAt: event.at };
      return { ...state, status: 'up-to-date', version: null, percent: 0, checkedAt: event.at };

    case 'download-started':
      return state.status === 'available' ? { ...state, status: 'downloading', percent: 0 } : state;

    case 'progress':
      return state.status === 'downloading' ? { ...state, percent: clampPercent(event.percent) } : state;

    case 'downloaded':
      return { ...state, status: 'ready', version: event.version, percent: 100 };

    // Back to the offer, not to a failure: the version is still there to be had, and a state
    // that kept saying "Downloading... 40%" with nothing moving would strand the user with a
    // frozen progress bar and no button.
    case 'download-failed':
      return state.status === 'downloading' ? { ...state, status: 'available', percent: 0 } : state;

    case 'unreachable':
      // Rule 2.
      return HOLDS_AN_OFFER.has(state.status) ? state : { ...state, status: 'unreachable' };

    default:
      return state;
  }
}

/** One line for the Customize row, which is the only place any of this is described. */
export function updateSummary(state: UpdateState): string {
  switch (state.status) {
    case 'unsupported':
      return `Version ${state.currentVersion}`;
    case 'checking':
      return 'Checking for updates...';
    case 'available':
      return `Version ${state.version} available`;
    case 'downloading':
      return `Downloading ${state.version}... ${state.percent}%`;
    case 'ready':
      return `Version ${state.version} ready to install`;
    case 'up-to-date':
      return `Version ${state.currentVersion}, up to date`;
    // A check that could not reach the feed is not the user's problem to solve, so it reads as
    // the plain version rather than as a failure. The dialog says when it last succeeded.
    case 'unreachable':
    case 'idle':
    default:
      return `Version ${state.currentVersion}`;
  }
}

/**
 * The chip raised onto the shut Customize row, or nothing.
 *
 * Nothing for a failed check, on purpose: the row must not nag about a feed the user cannot
 * reach and did not ask about.
 */
export function updateAttention(state: UpdateState): string | undefined {
  if (state.status === 'available') return 'Update';
  if (state.status === 'ready') return 'Restart';
  return undefined;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  // SemVer 11.4.3: numeric identifiers sort below alphanumeric ones.
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCores(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index++) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/**
 * SemVer precedence: -1, 0 or 1, or null when either side is not a version at all.
 * Build metadata is ignored, as the spec says.
 */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;

  const core = compareCores(a, b);
  if (core !== 0) return core;

  // A release outranks any prerelease of the same core.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const difference = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether `candidate` is a release the running build should be told about.
 *
 * A locally packaged build is versioned `<newest desktop tag>-local.<sha>` by
 * scripts/package-local.cjs, which is code at or after that tag. Plain SemVer ranks it BELOW the
 * tag it was cut from, so the same release would be offered back to it forever; comparing only
 * the core version keeps it quiet until a strictly newer release ships. Anything unparsable is
 * not newer: a notice we cannot justify is worse than none.
 */
export function isNewerRelease(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const running = parseVersion(current);
  if (!next || !running) return false;
  if (running.prerelease[0] === 'local') return compareCores(next, running) > 0;
  return (compareVersions(candidate, current) ?? 0) > 0;
}

/**
 * The version the floating "update available" notice should announce, or null for no notice.
 *
 * Shown while anything newer is on offer - found, downloading or staged - and hidden for the one
 * version the user dismissed. A later version is a different string, so it shows again.
 */
export function updateNoticeVersion(state: UpdateState): string | null {
  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'ready') return null;
  const version = state.version;
  if (!version || !isNewerRelease(version, state.currentVersion)) return null;
  if (state.dismissedVersion === version) return null;
  return version;
}

/** What the app is in the middle of, counted across every conversation. */
export interface UpdateBusyReport {
  /** Sessions with a reply streaming right now. */
  replying: number;
  /** Sessions parked at the approval gate. */
  awaitingApproval: number;
  /** Background commands still running - dev servers, watchers, builds. */
  background: number;
}

export function isBusy(report: UpdateBusyReport): boolean {
  return report.replying > 0 || report.awaitingApproval > 0 || report.background > 0;
}

/**
 * The work an install would interrupt, in one sentence.
 *
 * Counts rather than names: the point is to tell the user there IS something to lose before
 * they restart, and a session title would not make that decision any easier.
 */
export function describeBusy(report: UpdateBusyReport): string {
  const parts: string[] = [];
  if (report.replying > 0) {
    parts.push(`${report.replying} ${report.replying === 1 ? 'session is' : 'sessions are'} still working`);
  }
  if (report.awaitingApproval > 0) {
    parts.push(
      `${report.awaitingApproval} ${report.awaitingApproval === 1 ? 'session is' : 'sessions are'} waiting for you`
    );
  }
  if (report.background > 0) {
    parts.push(`${report.background} background ${report.background === 1 ? 'process is' : 'processes are'} running`);
  }
  if (parts.length === 0) return 'Nothing is running.';
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
}

export type UpdateInstallResult =
  /** The app is quitting to install. Nothing follows this. */
  | { ok: true }
  | { ok: false; reason: 'not-ready' }
  /** Work is in flight. The caller may ask again with `force` once the user has decided. */
  | { ok: false; reason: 'busy'; busy: UpdateBusyReport };
