import { describe, expect, it } from 'vitest';
import { formatSideAppAlertMessage } from './message';
import { GAP_LOOKBACK_DAYS, PLATFORM_RULE, emptyWindowCounts, type ClientVerdict } from './rules';

const verdict: ClientVerdict = {
  clientId: 'client-1',
  armed: true,
  rule: 'failing',
  lastHour: { ...emptyWindowCounts(), successes: 1, failures: 9, ourFaultFailures: 8, reasons: { agent_failed: 8 } },
  hoursSinceSuccess: 7.4,
  silenceThresholdHours: 6,
  topReasons: [{ reason: 'agent_failed', count: 8 }],
};

const bodyOf = (message: { blocks: unknown[] }) => (message.blocks[0] as { text: { text: string } }).text.text;

describe('formatSideAppAlertMessage', () => {
  it('names the app, rule, counts, top reasons and the board link', () => {
    const text = bodyOf(
      formatSideAppAlertMessage({
        phase: 'open',
        rule: 'failing',
        appName: 'Notes <app>',
        clientId: 'client-1',
        verdict,
        appUrl: 'https://app.example.test/',
        stageLabel: 'Staging',
      })
    );
    expect(text).toContain('Notes &lt;app&gt;');
    expect(text).toContain('requests are failing');
    expect(text).toContain('10 attempts, 1 succeeded, 9 failed (8 on our side)');
    expect(text).toContain('agent_failed (8)');
    expect(text).toContain(
      'https://app.example.test/admin?tab=credit-analytics&creditTab=side-apps&sideApp=client-1|Open Notes &lt;app&gt; on the Side apps board>'
    );
    expect(text).toContain('[Staging]');
  });

  it('encodes the client id in the per-app link', () => {
    const text = bodyOf(
      formatSideAppAlertMessage({
        phase: 'open',
        rule: 'failing',
        appName: 'Notes',
        clientId: 'a b&c',
        verdict,
        appUrl: 'https://app.example.test',
      })
    );
    expect(text).toContain('&sideApp=a%20b%26c|');
  });

  it('links the platform alert to the plain board', () => {
    const text = bodyOf(
      formatSideAppAlertMessage({
        phase: 'open',
        rule: PLATFORM_RULE,
        clientId: 'client-1',
        armedAppNames: ['A'],
        appUrl: 'https://app.example.test/',
      })
    );
    expect(text).toContain('creditTab=side-apps|Open the Side apps board>');
    expect(text).not.toContain('sideApp=');
  });

  it('reports the silence window for a silent app', () => {
    const text = bodyOf(
      formatSideAppAlertMessage({
        phase: 'reminder',
        rule: 'silent',
        appName: 'Notes',
        verdict: { ...verdict, rule: 'silent' },
      })
    );
    expect(text).toContain('still open');
    expect(text).toContain('No success for 7.4h; alert threshold 6h');
  });

  it('lists the armed apps on the platform alert', () => {
    const text = bodyOf(formatSideAppAlertMessage({ phase: 'open', rule: PLATFORM_RULE, armedAppNames: ['A', 'B'] }));
    expect(text).toContain('all connected apps are down');
    expect(text).toContain('A, B');
  });

  it('says how long a resolved alert was open and leaves out counts', () => {
    const text = bodyOf(
      formatSideAppAlertMessage({
        phase: 'resolved',
        rule: 'failing',
        appName: 'Notes',
        verdict,
        openedForMs: 3 * 60 * 60 * 1000,
      })
    );
    expect(text).toContain('recovered');
    expect(text).toContain('open for 3h');
    expect(text).not.toContain('Top failure reasons');
  });

  it.each([
    [0, 'under 1h'],
    [59 * 60 * 1000, 'under 1h'],
    [60 * 60 * 1000, '1h'],
  ])('prints the open time for %i ms as %s', (openedForMs, expected) => {
    const text = bodyOf(
      formatSideAppAlertMessage({ phase: 'resolved', rule: 'failing', appName: 'Notes', verdict, openedForMs })
    );
    expect(text).toContain(`open for ${expected}.`);
  });

  it('says an untracked alert closed for lack of traffic, without calling it recovered', () => {
    const message = formatSideAppAlertMessage({ phase: 'untracked', rule: 'silent', appName: 'Notes' });
    const text = bodyOf(message);
    expect(message.text).toBe(`Connected app alert closed: Notes, no traffic for ${GAP_LOOKBACK_DAYS} days`);
    expect(text).toContain('closed without a recovery');
    expect(text).not.toContain('recovered');
  });
});
