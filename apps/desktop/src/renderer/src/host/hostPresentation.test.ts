import { describe, expect, it } from 'vitest';
import type { HostConnectionState, HostEntry } from '@shared/hostConnection';
import { fakeHostInfo } from '../__fixtures__/chatBackedHostBridge';
import {
  accountLine,
  failureMessage,
  failureTitle,
  formatLastSeen,
  hostActions,
  hostBadgeText,
  hostNewerNote,
  hostVersionRelation,
  hostStatusView,
  sendBlockAction,
  sendBlockedReason,
  sshCommand,
  updateAvailable,
} from './hostPresentation';

const NOW = 1_000_000_000;
const remote = (state: HostConnectionState): HostEntry => ({
  hostId: 'devbox',
  label: 'devbox',
  kind: 'remote',
  state,
});
const connected = (hostVersion = '2.0.0'): HostConnectionState => ({
  status: 'connected',
  info: { ...fakeHostInfo('devbox'), hostVersion },
  latencyMs: 40,
});
const failure = {
  kind: 'sshFailed',
  detail: 'Connection failed',
  stderrTail: 'Permission denied (publickey).\n',
} as const;

describe('hostActions', () => {
  it.each<[string, HostConnectionState, string[]]>([
    ['connecting', { status: 'connecting' }, ['disconnect']],
    ['reconnecting', { status: 'reconnecting', attempt: 2, nextRetryAt: NOW }, ['reconnect', 'disconnect']],
    ['connected and current', connected(), ['reconnect', 'disconnect']],
    ['connected with an older host program', connected('1.0.0'), ['update', 'reconnect', 'disconnect']],
    ['turned off', { status: 'offline', reason: 'disconnected', lastSeenAt: null }, ['connect', 'remove']],
    ['unreachable', { status: 'offline', reason: 'unreachable', lastSeenAt: null }, ['reconnect', 'remove']],
    ['signed out of Bike4Mind', { status: 'offline', reason: 'signedOut', lastSeenAt: null }, ['signInApp', 'remove']],
    ['connected with a newer host program', connected('3.0.0'), ['reconnect', 'disconnect']],
    ['not installed', { status: 'needsInstall' }, ['install', 'remove']],
    ['update required', { status: 'needsUpdate', required: true }, ['update', 'remove']],
    ['needs sign-in', { status: 'needsSignIn' }, ['signIn', 'disconnect', 'remove']],
    ['failed', { status: 'failed', failure }, ['reconnect', 'remove']],
  ])('%s', (_name, state, expected) => {
    expect(hostActions(remote(state), '2.0.0')).toEqual(expected);
  });

  it('offers nothing for the local host', () => {
    expect(hostActions({ ...remote(connected()), kind: 'local' }, '2.0.0')).toEqual([]);
  });
});

describe('updateAvailable', () => {
  it('compares the host program with this Desktop, and never guesses before the version is known', () => {
    expect(updateAvailable(connected('1.0.0'), '2.0.0')).toBe(true);
    expect(updateAvailable(connected('2.0.0'), '2.0.0')).toBe(false);
    expect(updateAvailable(connected('1.0.0'), '')).toBe(false);
  });

  it('compares versions as versions, so 10 is newer than 9 and a newer host is no update', () => {
    expect(updateAvailable(connected('1.9.0'), '1.10.0')).toBe(true);
    expect(updateAvailable(connected('1.10.0'), '1.9.0')).toBe(false);
    expect(updateAvailable(connected('3.0.0'), '2.0.0')).toBe(false);
    expect(updateAvailable(connected('not-a-version'), '2.0.0')).toBe(false);
  });
});

describe('hostVersionRelation', () => {
  it('says older, same, newer, or unknown', () => {
    expect(hostVersionRelation(connected('1.0.0'), '2.0.0')).toBe('older');
    expect(hostVersionRelation(connected('2.0.0'), '2.0.0')).toBe('same');
    expect(hostVersionRelation(connected('3.0.0'), '2.0.0')).toBe('newer');
    expect(hostVersionRelation(connected('3.0.0'), '')).toBe('unknown');
    expect(hostVersionRelation({ status: 'needsInstall' }, '2.0.0')).toBe('unknown');
  });

  it('notes a newer host and nothing else', () => {
    expect(hostNewerNote(connected('3.0.0'), '2.0.0')).toContain('Update Desktop');
    expect(hostNewerNote(connected('1.0.0'), '2.0.0')).toBeNull();
    expect(hostNewerNote(connected('2.0.0'), '2.0.0')).toBeNull();
  });
});

describe('sendBlockAction', () => {
  it('offers Reconnect for a dropped host, Sign in when this computer is signed out, and nothing while waiting', () => {
    expect(sendBlockAction({ status: 'offline', reason: 'unreachable', lastSeenAt: null })).toBe('reconnect');
    expect(sendBlockAction({ status: 'offline', reason: 'signedOut', lastSeenAt: null })).toBe('signInApp');
    expect(sendBlockAction({ status: 'failed', failure })).toBe('reconnect');
    expect(sendBlockAction({ status: 'connecting' })).toBeNull();
  });
});

describe('hostStatusView', () => {
  it('says offline with when it was last seen', () => {
    const view = hostStatusView(
      { status: 'offline', reason: 'noNetwork', lastSeenAt: NOW - 2 * 3_600_000 },
      '2.0.0',
      NOW
    );
    expect(view.label).toBe('Offline 2h ago');
    expect(view.tone).toBe('neutral');
  });

  it('names the failure kind for a failed host', () => {
    expect(hostStatusView({ status: 'failed', failure }, '2.0.0', NOW)).toMatchObject({
      label: 'Failed',
      tone: 'danger',
      detail: 'SSH could not connect',
    });
  });
});

describe('hostBadgeText', () => {
  it('is empty for a connected current host and short for every other state', () => {
    expect(hostBadgeText(connected(), '2.0.0', NOW)).toBeNull();
    expect(hostBadgeText(connected('1.0.0'), '2.0.0', NOW)).toBe('update');
    expect(hostBadgeText({ status: 'needsSignIn' }, '2.0.0', NOW)).toBe('sign in');
    expect(hostBadgeText({ status: 'offline', reason: 'unreachable', lastSeenAt: NOW - 120_000 }, '2.0.0', NOW)).toBe(
      'offline 2 min ago'
    );
  });
});

describe('formatLastSeen', () => {
  it.each([
    [null, 'a while ago'],
    [NOW - 5_000, 'just now'],
    [NOW - 5 * 60_000, '5 min ago'],
    [NOW - 3 * 3_600_000, '3h ago'],
    [NOW - 2 * 86_400_000, '2d ago'],
  ])('%s', (lastSeenAt, expected) => {
    expect(formatLastSeen(lastSeenAt, NOW)).toBe(expected);
  });
});

describe('failure text', () => {
  it('shows what ssh wrote, falling back to the detail when it wrote nothing', () => {
    expect(failureMessage(failure)).toBe('Permission denied (publickey).');
    expect(failureMessage({ ...failure, stderrTail: '  ' })).toBe('Connection failed');
  });

  it('titles installer failures too', () => {
    expect(failureTitle({ kind: 'installFailed', detail: '', stderrTail: '' })).toMatch(/Installing/);
    expect(failureTitle({ kind: 'nodeTooOld', detail: '', stderrTail: '' })).toMatch(/too old/);
  });

  it('builds the command to reproduce it', () => {
    expect(sshCommand('devbox')).toBe('ssh devbox');
  });
});

describe('sendBlockedReason', () => {
  it('blocks any state but connected, keeping the draft', () => {
    expect(sendBlockedReason('devbox', connected(), NOW)).toBeNull();
    expect(sendBlockedReason('devbox', undefined, NOW)).toBeNull();
    expect(sendBlockedReason('devbox', { status: 'offline', reason: 'unreachable', lastSeenAt: null }, NOW)).toMatch(
      /devbox is not connected \(offline a while ago\)/
    );
  });
});

describe('accountLine', () => {
  it('names the server the host is signed in on, never the raw account id', () => {
    expect(accountLine({ userId: 'u', environmentUrl: 'https://app.example.com/x' })).toBe(
      'Signed in on app.example.com'
    );
    expect(accountLine({ userId: 'u', environmentUrl: 'not a url' })).toBe('Signed in');
    expect(accountLine(null)).toBe('Not signed in');
  });
});
