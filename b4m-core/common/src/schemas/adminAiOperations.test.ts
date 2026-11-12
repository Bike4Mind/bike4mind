import { describe, expect, it } from 'vitest';
import {
  adminAiReadiness,
  adminAiDemotedMode,
  type AdminAiClassEvidence,
  type AdminAiClassRegistration,
} from './adminAiOperations';

const evidence: AdminAiClassEvidence = {
  feature: 'feedbackTriage',
  actionClass: 'labels',
  policyVersion: 'v1',
  mode: 'shadow',
  replayCases: 200,
  replayAgreed: 180,
  replayArtifact: 'replay-v1',
  onlineAccepted: 95,
  onlineOverridden: 5,
  onlineDays: 14,
  costlyOverrides: 0,
  unclassifiedOverrides: 0,
};
const registration: AdminAiClassRegistration = {
  feature: 'feedbackTriage',
  actionClass: 'labels',
  policyVersion: 'v1',
  reversible: true,
  handlerId: 'labels-v1',
  undoPath: '/api/admin/feedback/undo',
};
describe('admin AI exact autonomy thresholds', () => {
  it('accepts exact boundaries and requires an action registration for act', () => {
    expect(adminAiReadiness(evidence)).toEqual({ recommend: true, act: false, registered: false });
    expect(adminAiReadiness(evidence, registration)).toEqual({ recommend: true, act: true, registered: true });
  });
  it.each([{ replayCases: 199, replayAgreed: 180 }, { replayAgreed: 179 }, { replayArtifact: '' }])(
    'refuses recommend with insufficient replay %j',
    update => {
      expect(adminAiReadiness({ ...evidence, ...update }, registration).recommend).toBe(false);
    }
  );
  it.each([
    { onlineAccepted: 94, onlineOverridden: 6 },
    { onlineAccepted: 94, onlineOverridden: 5 },
    { onlineDays: 13.999 },
    { costlyOverrides: 1 },
    { unclassifiedOverrides: 1 },
  ])('refuses act with insufficient online evidence %j', update => {
    expect(adminAiReadiness({ ...evidence, ...update }, registration).act).toBe(false);
  });
  it('does not reuse another policy or class registration', () => {
    expect(adminAiReadiness(evidence, { ...registration, policyVersion: 'v2' }).act).toBe(false);
    expect(adminAiReadiness(evidence, { ...registration, actionClass: 'delete' }).act).toBe(false);
  });
  it('demotes strictly above 10%, one rung, only with new decisions', () => {
    const latest = new Date('2026-01-10');
    expect(adminAiDemotedMode('act', 90, 10, latest, null)).toBe('act');
    expect(adminAiDemotedMode('act', 89, 11, latest, null)).toBe('recommend');
    expect(adminAiDemotedMode('recommend', 89, 11, latest, latest)).toBe('recommend');
    expect(adminAiDemotedMode('recommend', 89, 11, new Date('2026-01-11'), latest)).toBe('shadow');
    expect(adminAiDemotedMode('shadow', 0, 1, latest, null)).toBe('shadow');
    expect(adminAiDemotedMode('recommend', 0, 0, null, null)).toBe('recommend');
  });
});
