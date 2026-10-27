import { describe, it, expect } from 'vitest';
import { HubEntrySchema, type HubEntry, type HubEvidence } from '../schemas/modelHub';
import { fixtureManifest, OLD_PINS, ownEval, PINS, siblingBenchmark } from './__fixtures__/hubManifest';
import { entryTier, evidenceStrength, gradeBuild, meetsGrade } from './grade';

function fixtureEntry(id: string): HubEntry {
  const input = fixtureManifest().entries.find(e => e.id === id);
  return HubEntrySchema.parse(input);
}

const hybrid = fixtureEntry('hybrid-27b');
const digest = hybrid.builds[0].weights[0].sha256;

function evidence(over: Partial<HubEvidence> & { measured?: Partial<HubEvidence['measured']> } = {}): HubEvidence {
  const base = { ...siblingBenchmark(), samples: undefined, ownEval: undefined } as HubEvidence;
  return { ...base, ...over, measured: { ...base.measured, ...over.measured } };
}

describe('evidenceStrength', () => {
  it.each([
    [
      'independent reproducible benchmark on the exact file',
      { measured: { target: 'exact', sha256: digest } },
      'strong',
    ],
    ['independent reproducible speed run on the exact file', { kind: 'speed', measured: { target: 'exact' } }, 'weak'],
    ['independent reproducible sibling quant', {}, 'medium'],
    ['producer KLD on the exact file', { independent: false, kind: 'kld', measured: { target: 'exact' } }, 'medium'],
    [
      'producer tool eval on the exact file',
      { independent: false, kind: 'tool-eval', measured: { target: 'exact' } },
      'weak',
    ],
    ['private-harness sibling result', { reproducible: false }, 'weak'],
  ] as const)('%s is %s', (_label, over, expected) => {
    expect(evidenceStrength(evidence(over as Partial<HubEvidence>), hybrid, PINS)).toBe(expected);
  });

  it('counts base-model numbers as medium only for an official variant', () => {
    const base = evidence({ independent: false, measured: { target: 'base' } });
    const official = { ...hybrid, lineage: { ...hybrid.lineage, variantType: 'official' as const } };
    expect(evidenceStrength(base, official, PINS)).toBe('medium');
    expect(evidenceStrength(base, hybrid, PINS)).toBe('weak');
  });

  it('demotes an own eval to medium once the runtime pin moves', () => {
    const own = ownEval(digest) as HubEvidence;
    expect(evidenceStrength(own, hybrid, PINS)).toBe('strong');
    expect(evidenceStrength(own, hybrid, OLD_PINS)).toBe('medium');
  });
});

describe('gradeBuild', () => {
  const [q6, iq4, iq3] = hybrid.builds;

  it('grades A for a current own eval plus another medium-or-better item', () => {
    expect(gradeBuild(hybrid, iq4, PINS)).toBe('A');
  });

  it('grades B for a current own eval alone', () => {
    expect(gradeBuild(hybrid, q6, PINS)).toBe('B');
  });

  it('grades C for an own eval on an older pin or suite', () => {
    expect(gradeBuild(hybrid, iq3, PINS)).toBe('C');
    expect(gradeBuild(hybrid, iq4, OLD_PINS)).toBe('C');
    expect(gradeBuild(hybrid, iq4, { ...PINS, evalSuite: 'b4m-local-v2' })).toBe('C');
  });

  it('never takes a speed run as the corroboration an A needs', () => {
    const official = { ...hybrid, lineage: { ...hybrid.lineage, variantType: 'official' as const } };
    const siblingSpeed = evidence({ kind: 'speed' });
    const baseSpeed = evidence({ kind: 'speed', independent: false, measured: { target: 'base' } });
    expect(gradeBuild(hybrid, { ...q6, evidence: [...q6.evidence, siblingSpeed] }, PINS)).toBe('B');
    expect(gradeBuild(official, { ...q6, evidence: [...q6.evidence, baseSpeed] }, PINS)).toBe('B');
    expect(gradeBuild(hybrid, { ...iq4, evidence: [...iq4.evidence, siblingSpeed] }, PINS)).toBe('A');
  });

  it('does not reach A on a stale own eval of the same build', () => {
    const stale = ownEval(digest, { version: OLD_PINS['llama-server'] }) as HubEvidence;
    expect(gradeBuild(hybrid, { ...q6, evidence: [...q6.evidence, stale] }, PINS)).toBe('B');
  });

  it('grades D for weak evidence only and none without evidence', () => {
    const weak = { ...q6, evidence: [evidence({ reproducible: false })] };
    expect(gradeBuild(hybrid, weak, PINS)).toBe('D');
    expect(gradeBuild(hybrid, { ...q6, evidence: [] }, PINS)).toBe('none');
  });

  it('compares grades against a policy minimum', () => {
    expect(meetsGrade('A', 'B')).toBe(true);
    expect(meetsGrade('B', 'B')).toBe(true);
    expect(meetsGrade('C', 'B')).toBe(false);
    expect(meetsGrade('none', 'D')).toBe(false);
  });
});

describe('entryTier', () => {
  it('takes the riskier of producer tier and variant type', () => {
    expect(entryTier(hybrid)).toBe('A');
    expect(entryTier(fixtureEntry('dense-9b-tuned'))).toBe('B');
    expect(entryTier(fixtureEntry('hybrid-27b-abliterated'))).toBe('C');
    const tierAProducerFineTune = {
      ...hybrid,
      lineage: { ...hybrid.lineage, variantType: 'fine-tune' as const },
    };
    expect(entryTier(tierAProducerFineTune)).toBe('B');
  });
});
