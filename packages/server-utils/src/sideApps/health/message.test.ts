import { describe, expect, it } from 'vitest';
import { formatSideAppAlertMessage } from './message';
import { PLATFORM_RULE, emptyWindowCounts, type ClientVerdict } from './rules';

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
        verdict,
        appUrl: 'https://app.example.test/',
        stageLabel: 'Staging',
      })
    );
    expect(text).toContain('Notes &lt;app&gt;');
    expect(text).toContain('requests are failing');
    expect(text).toContain('10 attempts, 1 succeeded, 9 failed (8 on our side)');
    expect(text).toContain('agent_failed (8)');
    expect(text).toContain('https://app.example.test/admin?tab=credit-analytics');
    expect(text).toContain('[Staging]');
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
});
