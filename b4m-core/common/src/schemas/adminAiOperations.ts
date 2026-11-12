import type { AdminAiFeature } from './adminAi';
import type { AdminAiMode } from './settings';

export type AdminAiAttempt = {
  feature: AdminAiFeature;
  policyVersion: string;
  outcome: 'suggestion' | 'cached' | 'skip' | 'running';
  skipReason?: string;
  suggestionId?: string;
  calls: number;
  knownCostUsd: number;
  costUnknown: boolean;
  startedAt: Date;
  finishedAt?: Date;
};

export type AdminAiClassEvidence = {
  feature: AdminAiFeature;
  actionClass: string;
  policyVersion: string;
  mode: AdminAiMode;
  replayCases: number;
  replayAgreed: number;
  replayArtifact: string;
  onlineAccepted: number;
  onlineOverridden: number;
  onlineDays: number;
  costlyOverrides: number;
  unclassifiedOverrides: number;
};

export type AdminAiClassRegistration = {
  feature: AdminAiFeature;
  actionClass: string;
  policyVersion: string;
  reversible: true;
  handlerId: string;
  undoPath: string;
};

export function adminAiReadiness(evidence: AdminAiClassEvidence, registration?: AdminAiClassRegistration) {
  const recommend =
    evidence.replayCases >= 200 &&
    evidence.replayAgreed / evidence.replayCases >= 0.9 &&
    evidence.replayAgreed <= evidence.replayCases &&
    Boolean(evidence.replayArtifact);
  const decided = evidence.onlineAccepted + evidence.onlineOverridden;
  const registered =
    registration?.feature === evidence.feature &&
    registration.actionClass === evidence.actionClass &&
    registration.policyVersion === evidence.policyVersion &&
    registration.reversible === true &&
    Boolean(registration.handlerId) &&
    /^\/api\/admin\//.test(registration.undoPath);
  const act =
    recommend &&
    registered &&
    decided >= 100 &&
    evidence.onlineAccepted / decided >= 0.95 &&
    evidence.onlineDays >= 14 &&
    evidence.costlyOverrides === 0 &&
    evidence.unclassifiedOverrides === 0;
  return { recommend, act: Boolean(act), registered: Boolean(registered) };
}

export function adminAiDemotedMode(
  mode: AdminAiMode,
  accepted: number,
  overridden: number,
  latestDecision: Date | null,
  lastDemotedDecision: Date | null
): AdminAiMode {
  if (
    !latestDecision ||
    (lastDemotedDecision && latestDecision <= lastDemotedDecision) ||
    overridden / (accepted + overridden) <= 0.1
  )
    return mode;
  return mode === 'act' ? 'recommend' : mode === 'recommend' ? 'shadow' : mode;
}

export const ADMIN_AI_LADDER_COPY =
  'Recommend: offline replay agreement at least 90% on at least 200 cases. Act: registered reversible action with Undo, at least 95% online agreement on at least 100 decided suggestions over 14 days, with no costly-direction override. Automatic demotion: one rung when 7-day overrides exceed 10%, using new decisions since the last demotion.';
