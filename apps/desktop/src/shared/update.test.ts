import { describe, expect, it } from 'vitest';
import {
  describeBusy,
  initialUpdateState,
  isBusy,
  MAX_RELEASE_NOTES_LENGTH,
  normalizeReleaseNotes,
  reduceUpdate,
  updateAttention,
  updateBannerVisible,
  updateSummary,
  type UpdateEvent,
  type UpdateState,
} from './update';

const AT = 1_700_000_000_000;

function drive(start: UpdateState, ...events: UpdateEvent[]): UpdateState {
  return events.reduce(reduceUpdate, start);
}

function supported(): UpdateState {
  return initialUpdateState('1.0.0', true);
}

describe('initialUpdateState', () => {
  it('is idle with a feed and unsupported without one', () => {
    expect(supported().status).toBe('idle');
    expect(initialUpdateState('1.0.0', false).status).toBe('unsupported');
  });
});

describe('reduceUpdate: the happy path', () => {
  it('walks idle -> checking -> available -> downloading -> ready', () => {
    const checking = reduceUpdate(supported(), { type: 'check-started' });
    expect(checking.status).toBe('checking');

    const available = reduceUpdate(checking, { type: 'available', version: '1.1.0', at: AT });
    expect(available).toMatchObject({ status: 'available', version: '1.1.0', checkedAt: AT });

    const downloading = reduceUpdate(available, { type: 'download-started' });
    expect(downloading.status).toBe('downloading');

    const progressed = reduceUpdate(downloading, { type: 'progress', percent: 42.4 });
    expect(progressed.percent).toBe(42);

    const ready = reduceUpdate(progressed, { type: 'downloaded', version: '1.1.0' });
    expect(ready).toMatchObject({ status: 'ready', version: '1.1.0', percent: 100 });
  });

  it('records no update as up-to-date and clears any stale version', () => {
    const state = drive(supported(), { type: 'check-started' }, { type: 'up-to-date', at: AT });
    expect(state).toMatchObject({ status: 'up-to-date', version: null, checkedAt: AT });
  });
});

describe('reduceUpdate: a failed check is quiet and never destructive', () => {
  it('lands as unreachable from a resting state', () => {
    expect(reduceUpdate(supported(), { type: 'unreachable' }).status).toBe('unreachable');
    const afterCheck = drive(supported(), { type: 'check-started' }, { type: 'unreachable' });
    expect(afterCheck.status).toBe('unreachable');
  });

  it('leaves checkedAt alone, because nothing was successfully checked', () => {
    const state = drive(
      supported(),
      { type: 'check-started' },
      { type: 'up-to-date', at: AT },
      { type: 'check-started' },
      { type: 'unreachable' }
    );
    expect(state.checkedAt).toBe(AT);
  });

  it('does not retract an update that is already offered', () => {
    const state = drive(
      supported(),
      { type: 'check-started' },
      { type: 'available', version: '1.1.0', at: AT },
      { type: 'unreachable' }
    );
    expect(state).toMatchObject({ status: 'available', version: '1.1.0' });
  });

  it('does not throw away a download in flight or one already staged', () => {
    const downloading = drive(
      supported(),
      { type: 'check-started' },
      { type: 'available', version: '1.1.0', at: AT },
      { type: 'download-started' },
      { type: 'unreachable' }
    );
    expect(downloading.status).toBe('downloading');

    const ready = drive(downloading, { type: 'downloaded', version: '1.1.0' }, { type: 'unreachable' });
    expect(ready.status).toBe('ready');
  });

  it('keeps a staged update even when a later check reports nothing new', () => {
    const state = drive(
      supported(),
      { type: 'check-started' },
      { type: 'available', version: '1.1.0', at: AT },
      { type: 'download-started' },
      { type: 'downloaded', version: '1.1.0' },
      { type: 'up-to-date', at: AT + 1000 }
    );
    expect(state).toMatchObject({ status: 'ready', version: '1.1.0', checkedAt: AT + 1000 });
  });
});

describe('reduceUpdate: a failed download', () => {
  it('returns to the offer with the progress cleared, not to a dead end', () => {
    const state = drive(
      supported(),
      { type: 'check-started' },
      { type: 'available', version: '1.1.0', at: AT },
      { type: 'download-started' },
      { type: 'progress', percent: 40 },
      { type: 'download-failed' }
    );
    expect(state).toMatchObject({ status: 'available', version: '1.1.0', percent: 0, checkedAt: AT });
    expect(updateSummary(state)).toBe('Version 1.1.0 available');
  });

  it('is ignored when no download is running, so it cannot undo a staged update', () => {
    const ready = drive(
      supported(),
      { type: 'available', version: '1.1.0', at: AT },
      { type: 'downloaded', version: '1.1.0' }
    );
    expect(reduceUpdate(ready, { type: 'download-failed' })).toBe(ready);

    const idle = supported();
    expect(reduceUpdate(idle, { type: 'download-failed' })).toBe(idle);
  });
});

describe('reduceUpdate: transitions that must not fire', () => {
  it('ignores everything once unsupported', () => {
    const off = initialUpdateState('1.0.0', false);
    expect(drive(off, { type: 'check-started' }, { type: 'available', version: '2.0.0', at: AT })).toBe(off);
  });

  it('does not blank an offer back to checking on a re-check', () => {
    const available = drive(supported(), { type: 'check-started' }, { type: 'available', version: '1.1.0', at: AT });
    expect(reduceUpdate(available, { type: 'check-started' })).toBe(available);
  });

  it('only starts a download from an available update', () => {
    expect(reduceUpdate(supported(), { type: 'download-started' }).status).toBe('idle');
  });

  it('ignores progress that arrives when nothing is downloading', () => {
    const state = reduceUpdate(supported(), { type: 'progress', percent: 50 });
    expect(state.percent).toBe(0);
  });

  it('clamps nonsense progress rather than rendering it', () => {
    const downloading = drive(
      supported(),
      { type: 'check-started' },
      { type: 'available', version: '1.1.0', at: AT },
      { type: 'download-started' }
    );
    expect(reduceUpdate(downloading, { type: 'progress', percent: 140 }).percent).toBe(100);
    expect(reduceUpdate(downloading, { type: 'progress', percent: -5 }).percent).toBe(0);
    expect(reduceUpdate(downloading, { type: 'progress', percent: Number.NaN }).percent).toBe(0);
  });

  it('returns the same object when nothing changed, so no push goes out', () => {
    const state = supported();
    expect(reduceUpdate(state, { type: 'progress', percent: 10 })).toBe(state);
  });
});

describe('updateSummary', () => {
  it('names the version in every resting state', () => {
    expect(updateSummary(supported())).toBe('Version 1.0.0');
    expect(updateSummary(initialUpdateState('1.0.0', false))).toBe('Version 1.0.0');
  });

  it('reads a failed check as the plain version, not as a failure', () => {
    const state = reduceUpdate(supported(), { type: 'unreachable' });
    expect(updateSummary(state)).toBe('Version 1.0.0');
  });

  it('describes an offer, a download and a staged update', () => {
    const available = drive(supported(), { type: 'check-started' }, { type: 'available', version: '1.1.0', at: AT });
    expect(updateSummary(available)).toBe('Version 1.1.0 available');

    const downloading = drive(available, { type: 'download-started' }, { type: 'progress', percent: 30 });
    expect(updateSummary(downloading)).toBe('Downloading 1.1.0... 30%');

    const ready = reduceUpdate(downloading, { type: 'downloaded', version: '1.1.0' });
    expect(updateSummary(ready)).toBe('Version 1.1.0 ready to install');
  });

  it('says so when up to date', () => {
    const state = drive(supported(), { type: 'check-started' }, { type: 'up-to-date', at: AT });
    expect(updateSummary(state)).toBe('Version 1.0.0, up to date');
  });
});

describe('updateAttention', () => {
  it('flags an offer and a staged update', () => {
    const available = drive(supported(), { type: 'check-started' }, { type: 'available', version: '1.1.0', at: AT });
    expect(updateAttention(available)).toBe('Update');
    expect(updateAttention(reduceUpdate(available, { type: 'downloaded', version: '1.1.0' }))).toBe('Restart');
  });

  it('never flags a failed check - that is not the user to solve', () => {
    expect(updateAttention(reduceUpdate(supported(), { type: 'unreachable' }))).toBeUndefined();
    expect(updateAttention(supported())).toBeUndefined();
    expect(
      updateAttention(drive(supported(), { type: 'check-started' }, { type: 'up-to-date', at: AT }))
    ).toBeUndefined();
  });
});

describe('isBusy / describeBusy', () => {
  const quiet = { replying: 0, awaitingApproval: 0, background: 0 };

  it('is quiet only when nothing at all is running', () => {
    expect(isBusy(quiet)).toBe(false);
    expect(isBusy({ ...quiet, replying: 1 })).toBe(true);
    expect(isBusy({ ...quiet, awaitingApproval: 1 })).toBe(true);
    expect(isBusy({ ...quiet, background: 1 })).toBe(true);
  });

  it('reads as a sentence, singular and plural', () => {
    expect(describeBusy(quiet)).toBe('Nothing is running.');
    expect(describeBusy({ ...quiet, replying: 1 })).toBe('1 session is still working.');
    expect(describeBusy({ ...quiet, background: 2 })).toBe('2 background processes are running.');
    expect(describeBusy({ replying: 2, awaitingApproval: 1, background: 3 })).toBe(
      '2 sessions are still working, 1 session is waiting for you and 3 background processes are running.'
    );
  });
});

describe('reduceUpdate: release notes', () => {
  it('carries the notes from the offer through the download', () => {
    const ready = drive(
      supported(),
      { type: 'check-started' },
      { type: 'available', version: '1.1.0', at: AT, notes: '- a restart banner' },
      { type: 'download-started' },
      { type: 'downloaded', version: '1.1.0' }
    );
    expect(ready).toMatchObject({ status: 'ready', version: '1.1.0', notes: '- a restart banner' });
  });

  it('prefers the notes the download reports, which are the ones for the staged bytes', () => {
    const ready = drive(
      supported(),
      { type: 'available', version: '1.1.0', at: AT, notes: 'offered' },
      { type: 'download-started' },
      { type: 'downloaded', version: '1.1.0', notes: 'downloaded' }
    );
    expect(ready.notes).toBe('downloaded');
  });

  it("never pins one version's notes on another", () => {
    const ready = drive(
      supported(),
      { type: 'available', version: '1.1.0', at: AT, notes: 'for 1.1.0' },
      { type: 'download-started' },
      { type: 'downloaded', version: '1.2.0' }
    );
    expect(ready).toMatchObject({ version: '1.2.0', notes: null });
  });

  it('drops the notes when the feed says there is nothing newer', () => {
    const state = drive(
      supported(),
      { type: 'available', version: '1.1.0', at: AT, notes: 'old offer' },
      { type: 'up-to-date', at: AT + 1 }
    );
    expect(state).toMatchObject({ status: 'up-to-date', version: null, notes: null });
  });

  it('starts with no notes, and an offer without notes has none', () => {
    expect(supported().notes).toBeNull();
    expect(reduceUpdate(supported(), { type: 'available', version: '1.1.0', at: AT }).notes).toBeNull();
  });
});

describe('normalizeReleaseNotes', () => {
  it('passes plain text through, trimmed', () => {
    expect(normalizeReleaseNotes('  - one\n- two  ')).toBe('- one\n- two');
  });

  it('is null for nothing, blanks and non-text', () => {
    expect(normalizeReleaseNotes(null)).toBeNull();
    expect(normalizeReleaseNotes(undefined)).toBeNull();
    expect(normalizeReleaseNotes('   ')).toBeNull();
    expect(normalizeReleaseNotes(42)).toBeNull();
    expect(normalizeReleaseNotes({ note: 'x' })).toBeNull();
  });

  it('joins the per-version form electron-updater uses when it collects several', () => {
    expect(
      normalizeReleaseNotes([
        { version: '1.2.0', note: 'second' },
        { version: '1.1.0', note: null },
        { version: '1.0.1', note: 'first' },
      ])
    ).toBe('second\n\nfirst');
  });

  it('strips markup instead of rendering it', () => {
    expect(normalizeReleaseNotes('<p>Fixed <b>it</b><br>now</p><script>alert(1)</script>')).toBe(
      'Fixed it\nnowalert(1)'
    );
  });

  it('caps what a manifest can push into the UI', () => {
    const long = 'x'.repeat(MAX_RELEASE_NOTES_LENGTH + 50);
    const capped = normalizeReleaseNotes(long);
    expect(capped).toHaveLength(MAX_RELEASE_NOTES_LENGTH + 3);
    expect(capped?.endsWith('...')).toBe(true);
  });
});

describe('updateBannerVisible', () => {
  const ready = drive(
    supported(),
    { type: 'available', version: '1.1.0', at: AT },
    { type: 'download-started' },
    { type: 'downloaded', version: '1.1.0' }
  );

  it('shows only once the update is staged', () => {
    expect(updateBannerVisible(ready, null)).toBe(true);
    expect(updateBannerVisible(reduceUpdate(supported(), { type: 'available', version: '1.1.0', at: AT }), null)).toBe(
      false
    );
    expect(updateBannerVisible(initialUpdateState('1.0.0', false), null)).toBe(false);
  });

  it('stays hidden for the dismissed version and comes back for the next one', () => {
    expect(updateBannerVisible(ready, '1.1.0')).toBe(false);
    expect(updateBannerVisible({ ...ready, version: '1.2.0' }, '1.1.0')).toBe(true);
  });
});
