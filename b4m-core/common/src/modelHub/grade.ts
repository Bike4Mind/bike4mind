import {
  EVIDENCE_GRADES,
  type EvidenceGrade,
  type HubBuild,
  type HubEntry,
  type HubEvidence,
  type HubRuntime,
  type ProducerTier,
} from '../schemas/modelHub';

export type EvidenceStrength = 'strong' | 'medium' | 'weak';
export type BuildGrade = EvidenceGrade | 'none';

/**
 * The runtime versions the app ships with, written exactly as smoke and own-eval records spell them, and the
 * own-eval suite whose scores it compares.
 */
export type RuntimePins = Record<HubRuntime, string> & { evalSuite: string };

export function isCurrentOwnEval(evidence: HubEvidence, pins: RuntimePins): boolean {
  const own = evidence.ownEval;
  return (
    evidence.kind === 'own-eval' &&
    own !== undefined &&
    own.suite === pins.evalSuite &&
    own.runtimeVersion === pins[own.runtime]
  );
}

export function evidenceStrength(evidence: HubEvidence, entry: HubEntry, pins: RuntimePins): EvidenceStrength {
  // An own eval on an older runtime pin or suite no longer proves the build as shipped.
  if (evidence.kind === 'own-eval') return isCurrentOwnEval(evidence, pins) ? 'strong' : 'medium';
  const { independent, reproducible, measured, kind } = evidence;
  if (independent && reproducible && measured.target === 'exact' && kind !== 'speed') return 'strong';
  if (independent && reproducible && measured.target === 'sibling') return 'medium';
  if (!independent && measured.target === 'exact' && (kind === 'kld' || kind === 'ppl' || kind === 'benchmark')) {
    return 'medium';
  }
  if (measured.target === 'base' && entry.lineage.variantType === 'official') return 'medium';
  return 'weak';
}

/**
 * A: a current own eval plus one more strong or medium quality item from outside our harness; a speed run never
 * counts. B: any strong item. C: any medium item. D: weak items only. Computed from evidence, never stored.
 */
export function gradeBuild(entry: HubEntry, build: HubBuild, pins: RuntimePins): BuildGrade {
  if (build.evidence.length === 0) return 'none';
  const strengths = build.evidence.map(e => evidenceStrength(e, entry, pins));
  const current = build.evidence.some(e => isCurrentOwnEval(e, pins));
  const corroborated = strengths.some((s, i) => {
    const { kind } = build.evidence[i];
    return kind !== 'own-eval' && kind !== 'speed' && s !== 'weak';
  });
  if (current && corroborated) return 'A';
  if (strengths.includes('strong')) return 'B';
  if (strengths.includes('medium')) return 'C';
  return 'D';
}

/** True when `grade` is at least as good as `minimum`. */
export function meetsGrade(grade: BuildGrade, minimum: EvidenceGrade): boolean {
  return grade !== 'none' && EVIDENCE_GRADES.indexOf(grade) <= EVIDENCE_GRADES.indexOf(minimum);
}

const VARIANT_TIER: Record<HubEntry['lineage']['variantType'], ProducerTier> = {
  official: 'A',
  requant: 'A',
  'fine-tune': 'B',
  merge: 'B',
  distill: 'B',
  'expert-pruned': 'B',
  abliterated: 'C',
};

/** The riskier of the producer's tier and the tier its variant type implies. */
export function entryTier(entry: HubEntry): ProducerTier {
  const tiers: ProducerTier[] = [entry.lineage.producer.tier, VARIANT_TIER[entry.lineage.variantType]];
  if (entry.flags.abliterated) tiers.push('C');
  return tiers.reduce((worst, t) => (t > worst ? t : worst));
}
