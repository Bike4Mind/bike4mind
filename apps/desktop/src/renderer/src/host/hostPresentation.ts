import type {
  HostAccount,
  HostConnectionState,
  HostEntry,
  HostInstallFailure,
  HostOfflineReason,
} from '@shared/hostConnection';
import type { HostConnectFailure } from '@shared/hostProtocol';
import { compareVersions } from '@shared/update';

/** Everything a user can do to a host from Connections or its panel. */
export type HostAction =
  | 'connect'
  | 'reconnect'
  | 'disconnect'
  | 'install'
  | 'update'
  /** Signs the host in to the user's account (device flow). */
  | 'signIn'
  /** Signs this Desktop in to Bike4Mind, which every host connection needs. */
  | 'signInApp'
  | 'remove';

export type HostTone = 'success' | 'warning' | 'danger' | 'neutral' | 'primary';

export type HostStatusView = {
  label: string;
  tone: HostTone;
  /** One line under the label when the state has more to say. */
  detail?: string;
};

/** How the host program's version compares with this Desktop's; unknown when either is not a version. */
export type HostVersionRelation = 'older' | 'same' | 'newer' | 'unknown';

export function hostVersionRelation(state: HostConnectionState, desktopVersion: string): HostVersionRelation {
  if (state.status !== 'connected' || desktopVersion === '') return 'unknown';
  const order = compareVersions(state.info.hostVersion, desktopVersion);
  if (order === null) return 'unknown';
  return order < 0 ? 'older' : order > 0 ? 'newer' : 'same';
}

/** A host that is behind this Desktop. Main keeps it connected and offers nothing else. */
export function updateAvailable(state: HostConnectionState, desktopVersion: string): boolean {
  if (state.status === 'needsUpdate') return true;
  return hostVersionRelation(state, desktopVersion) === 'older';
}

/** Shown instead of an Update action when the host is ahead: installing this Desktop's build would be a downgrade. */
export function hostNewerNote(state: HostConnectionState, desktopVersion: string): string | null {
  if (hostVersionRelation(state, desktopVersion) !== 'newer' || state.status !== 'connected') return null;
  return `The host program (${state.info.hostVersion}) is newer than this Desktop (${desktopVersion}). Update Desktop to match; the host is left as it is.`;
}

const OFFLINE_DETAIL: Record<HostOfflineReason, string> = {
  disconnected: 'Turned off. Connect to use it again.',
  signedOut: 'Sign in to Bike4Mind on this computer to connect hosts.',
  noNetwork: 'Waiting for the network. It reconnects by itself.',
  unreachable: 'Could not be reached. It keeps trying in the background.',
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "5 min ago", "2h ago", "3d ago"; "a while ago" when it was never seen. */
export function formatLastSeen(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return 'a while ago';
  const elapsed = Math.max(0, now - lastSeenAt);
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

const FAILURE_TITLE: Record<HostConnectFailure['kind'], string> = {
  sshFailed: 'SSH could not connect',
  notInstalled: 'The host program is not installed',
  nodeMissing: 'Node.js is not installed on this machine',
  nodeTooOld: 'Node.js on this machine is too old',
  unsupportedPlatform: 'This machine is not supported',
  daemonStartTimeout: 'The host program did not start',
  daemonVersionMismatch: 'The host program is a different version',
  protocolMismatch: 'The host program speaks another protocol version',
  lost: 'The connection was lost',
};

export function failureTitle(failure: HostConnectFailure | HostInstallFailure): string {
  if (failure.kind in FAILURE_TITLE) return FAILURE_TITLE[failure.kind as HostConnectFailure['kind']];
  if (failure.kind === 'installBusy') return 'Another install is running on this machine';
  if (failure.kind === 'artifactUnavailable') return 'This app has no copy of the host program to install';
  return 'Installing the host program failed';
}

/** The real message to show: what ssh or the host wrote to stderr, else main's own detail. Plain text only. */
export function failureMessage(failure: HostConnectFailure | HostInstallFailure): string {
  const stderr = failure.stderrTail.trim();
  return stderr === '' ? failure.detail : stderr;
}

/** What a user can paste into a terminal to see the same failure; the alias is validated by main before it is listed. */
export function sshCommand(alias: string): string {
  return `ssh ${alias}`;
}

export function hostStatusView(state: HostConnectionState, desktopVersion: string, now: number): HostStatusView {
  switch (state.status) {
    case 'connecting':
      return { label: 'Connecting', tone: 'primary' };
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'warning', detail: `Attempt ${state.attempt}` };
    case 'connected':
      if (updateAvailable(state, desktopVersion)) return { label: 'Update available', tone: 'primary' };
      return { label: 'Connected', tone: 'success', detail: hostNewerNote(state, desktopVersion) ?? undefined };
    case 'offline':
      return {
        label: `Offline ${formatLastSeen(state.lastSeenAt, now)}`,
        tone: 'neutral',
        detail: OFFLINE_DETAIL[state.reason],
      };
    case 'needsInstall':
      return { label: 'Not installed', tone: 'neutral', detail: 'The host program is not on this machine yet.' };
    case 'needsUpdate':
      return {
        label: state.required ? 'Update required' : 'Update available',
        tone: state.required ? 'warning' : 'primary',
      };
    case 'needsSignIn':
      return { label: 'Needs sign-in', tone: 'warning', detail: 'Sign in so the host can use your account.' };
    case 'accountMismatch':
      return {
        label: 'Different account',
        tone: 'danger',
        detail: 'The host is signed in to another Bike4Mind account than this app.',
      };
    case 'failed':
      return { label: 'Failed', tone: 'danger', detail: failureTitle(state.failure) };
  }
}

const OFFLINE_RECOVERY: Record<HostOfflineReason, HostAction> = {
  disconnected: 'connect',
  signedOut: 'signInApp',
  noNetwork: 'reconnect',
  unreachable: 'reconnect',
};

/** The fix a composer offers for a host that cannot take work; null when only waiting helps. */
export function sendBlockAction(state: HostConnectionState): 'reconnect' | 'signInApp' | null {
  if (state.status === 'offline') return state.reason === 'signedOut' ? 'signInApp' : 'reconnect';
  return state.status === 'failed' ? 'reconnect' : null;
}

/** The action buttons a host in this state offers, primary first. The local host offers none. */
export function hostActions(entry: HostEntry, desktopVersion: string): HostAction[] {
  if (entry.kind === 'local') return [];
  const { state } = entry;
  switch (state.status) {
    case 'connecting':
      return ['disconnect'];
    case 'reconnecting':
      return ['reconnect', 'disconnect'];
    case 'connected':
      return [...(updateAvailable(state, desktopVersion) ? (['update'] as const) : []), 'reconnect', 'disconnect'];
    case 'offline':
      return [OFFLINE_RECOVERY[state.reason], 'remove'];
    case 'needsInstall':
      return ['install', 'remove'];
    case 'needsUpdate':
      return ['update', 'remove'];
    case 'needsSignIn':
      return ['signIn', 'disconnect', 'remove'];
    case 'accountMismatch':
      return ['disconnect', 'remove'];
    case 'failed':
      return ['reconnect', 'remove'];
  }
}

/** Where work can be sent right now: only a connected host takes it. */
export function hostAcceptsWork(state: HostConnectionState | undefined): boolean {
  return state?.status === 'connected';
}

/** The sentence under a disabled composer or a stale project: why nothing can be sent, in the state's own words. */
export function sendBlockedReason(label: string, state: HostConnectionState | undefined, now: number): string | null {
  if (!state || hostAcceptsWork(state)) return null;
  const view = hostStatusView(state, '', now);
  return `${label} is not connected (${view.label.toLowerCase()}). Your message is kept; send it once the host is back.`;
}

/**
 * Who a host is signed in as. The protocol reports an opaque account id and the server it belongs
 * to, not a name or an email, so only the server is shown.
 */
export function accountLine(account: HostAccount): string {
  if (!account) return 'Not signed in';
  try {
    return `Signed in on ${new URL(account.environmentUrl).host}`;
  } catch {
    return 'Signed in';
  }
}

/** The few words beside a host's name in the sidebar; null when it is connected and current. */
export function hostBadgeText(state: HostConnectionState, desktopVersion: string, now: number): string | null {
  if (state.status === 'connected') return updateAvailable(state, desktopVersion) ? 'update' : null;
  if (state.status === 'needsSignIn') return 'sign in';
  return hostStatusView(state, desktopVersion, now).label.toLowerCase();
}
