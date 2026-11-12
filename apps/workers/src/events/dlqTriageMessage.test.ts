import { describe, expect, it, vi } from 'vitest';
import type { AdminAiSuggestionItem } from '@bike4mind/common';
import { buildDlqTriageSection } from './dlqTriageMessage';
import { postAlarmToSlack } from './alarmSlackMessage';

describe('DLQ triage Slack surface', () => {
  it('renders a short dead-letter id and a console link, not proposed-action facts', () => {
    const suggestion = {
      entityId: 'fixture:123456789-secret',
      actionClass: 'safe-transient',
      verdict: 'replay',
      reasons: [{ text: 'Recorded timeout on a safe queue.' }],
      proposedAction: { body: 'private payload' },
    } as unknown as AdminAiSuggestionItem;
    const text = buildDlqTriageSection('fixture', [suggestion], 'https://example.test');
    expect(text).toContain('Dead letter 12345678: safe-transient - replay');
    expect(text).toContain('queue=fixture&message=123456789-secret');
    expect(text).not.toContain('private payload');
  });
  it('reports ambiguous delivery without retrying', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(
        postAlarmToSlack('https://example.test', { text: 'triage', blocks: [] }, { atMostOnce: true })
      ).resolves.toEqual({ state: 'unconfirmed' });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
