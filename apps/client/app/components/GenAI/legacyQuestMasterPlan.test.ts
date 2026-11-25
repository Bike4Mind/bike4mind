import { describe, expect, it } from 'vitest';
import { isLegacyQuestMasterMessage, LEGACY_QUESTMASTER_NOTE } from './legacyQuestMasterPlan';

describe('isLegacyQuestMasterMessage', () => {
  it('is true for a message that points at a legacy plan', () => {
    expect(isLegacyQuestMasterMessage({ questMasterPlanId: '6650f0c2a1b2c3d4e5f60718' })).toBe(true);
  });

  it('is true for a message that holds only the stored plan-generator JSON', () => {
    expect(isLegacyQuestMasterMessage({ questMasterReply: '{"title":"Error Processing Quest","quests":[]}' })).toBe(
      true
    );
  });

  it('is false for an ordinary reply', () => {
    expect(isLegacyQuestMasterMessage({})).toBe(false);
    expect(isLegacyQuestMasterMessage({ questMasterPlanId: null, questMasterReply: null })).toBe(false);
    expect(isLegacyQuestMasterMessage({ questMasterPlanId: '', questMasterReply: '' })).toBe(false);
    expect(isLegacyQuestMasterMessage(undefined)).toBe(false);
  });
});

describe('LEGACY_QUESTMASTER_NOTE', () => {
  it('names the folder the legacy plan conversion writes to', () => {
    expect(LEGACY_QUESTMASTER_NOTE).toBe(
      'This reply had a QuestMaster plan. QuestMaster plans are no longer shown in chat. ' +
        'Saved plans were copied as markdown files to the "Questmaster archive" folder in your files.'
    );
  });
});
