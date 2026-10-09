import { describe, expect, it } from 'vitest';
import { buildPendingActionButtons } from './pendingActionButtons';

describe('buildPendingActionButtons', () => {
  it('rejects a quest without a pending action', () => {
    expect(() => buildPendingActionButtons({ _id: { toString: () => 'quest-1' } })).toThrow(
      'Cannot build confirmation buttons without a pending action'
    );
  });

  it('uses the stored action timestamp in both button values', () => {
    const questId = '0123456789abcdef01234567';
    const pendingActionTs = 1_700_000_000_000;
    const blocks = buildPendingActionButtons({
      _id: { toString: () => questId },
      pendingAction: { ts: pendingActionTs },
    });
    const actions = blocks.find(block => block.type === 'actions');
    const elements = (actions?.elements ?? []) as Array<{ action_id: string; value: string }>;

    expect(elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_id: 'confirm_action', value: `${questId}:${pendingActionTs}` }),
        expect.objectContaining({ action_id: 'cancel_action', value: `${questId}:${pendingActionTs}` }),
      ])
    );
  });
});
