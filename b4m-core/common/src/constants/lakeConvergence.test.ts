import { describe, it, expect } from 'vitest';
import { CONVERGENCE_PAUSED_CHUNK_NOTE, CONVERGENCE_PAUSED_NOTE } from './chunking';
import {
  BULK_CHANGE_MIN_MEMBERS,
  decideMemberConvergence,
  isConvergeablePolicy,
  planLakeConvergence,
  requiresBulkChangeConfirmation,
  type ConvergenceMemberInput,
  type LakeConvergencePolicy,
} from './lakeConvergence';

const policy: LakeConvergencePolicy = {
  requiredTarget: 512,
  effectiveRequiredTarget: 512,
  policyChars: 3072, // 512 * CHARS_PER_TOKEN_SERVE_BOUND
};

/** A settled, measured, conformant member - every test below perturbs exactly one field of it. */
const conformantMember: ConvergenceMemberInput = {
  fabFileId: 'f1',
  userId: 'u1',
  fileName: 'a.pdf',
  chunkCount: 8,
  vectorizedChunkCount: 8,
  error: null,
  notes: null,
  maxChunkCharLength: 3000,
  chunkedPassageTokenTarget: 512,
};

const member = (over: Partial<ConvergenceMemberInput>): ConvergenceMemberInput => ({
  ...conformantMember,
  ...over,
});

describe('isConvergeablePolicy (epic decision 5)', () => {
  it('converges an explicit policy and never an inherited one', () => {
    expect(isConvergeablePolicy({ source: 'explicit' })).toBe(true);
    expect(isConvergeablePolicy({ source: 'inherited' })).toBe(false);
  });
});

describe('decideMemberConvergence', () => {
  it('leaves a conformant member alone', () => {
    expect(decideMemberConvergence(conformantMember, policy)).toEqual({
      converge: false,
      fabFileId: 'f1',
      reason: 'conformant',
    });
  });

  it('converges a member whose stamped target differs from the policy', () => {
    expect(decideMemberConvergence(member({ chunkedPassageTokenTarget: 2100 }), policy)).toEqual({
      converge: true,
      fabFileId: 'f1',
      userId: 'u1',
      fileName: 'a.pdf',
      overshootChars: 0,
    });
  });

  it('records the overshoot on a member it converges, so the wave can be ordered worst-first', () => {
    const decision = decideMemberConvergence(
      member({ chunkedPassageTokenTarget: 2100, maxChunkCharLength: 5000 }),
      policy
    );
    expect(decision).toMatchObject({ converge: true, overshootChars: 5000 - policy.policyChars });
  });

  // The termination bug this arm exists to prevent. policyChars is a CHARACTER budget and the
  // chunker is bounded in TOKENS, so an overshoot can survive a rewrite at the policy's own target -
  // and OR'd with the target arm that returned converge:true on identical inputs, forever, with no
  // attempt counter and no `error` to catch it. The stamp is what makes it terminal.
  it('refuses an overshoot on chunks already built at the policy target, rather than rewriting forever', () => {
    expect(decideMemberConvergence(member({ maxChunkCharLength: 5000 }), policy)).toEqual({
      converge: false,
      fabFileId: 'f1',
      reason: 'irreducibleOvershoot',
    });
  });

  // The same overshoot IS a violation while the stamp disagrees: that rewrite is the one that both
  // repairs the target and writes the stamp deciding it next time.
  it('still converges an overshooting member whose stamped target has not reached the policy yet', () => {
    expect(
      decideMemberConvergence(member({ chunkedPassageTokenTarget: 2100, maxChunkCharLength: 5000 }), policy)
    ).toMatchObject({ converge: true });
  });

  // Two configured targets that both exceed the model window clamp to the same effective limit, and
  // must not read as a violation - the like-for-like rule #1662 established. Comparing the RAW
  // target would rewrite this member on every pass and never converge.
  it('compares against the EFFECTIVE required target, not the raw one', () => {
    const clamped: LakeConvergencePolicy = { requiredTarget: 8192, effectiveRequiredTarget: 6554, policyChars: 39324 };
    expect(decideMemberConvergence(member({ chunkedPassageTokenTarget: 6554 }), clamped)).toMatchObject({
      converge: false,
      reason: 'conformant',
    });
  });

  it('refuses a terminally failed member instead of re-paying for the same failure', () => {
    expect(decideMemberConvergence(member({ error: 'corrupt pdf' }), policy)).toMatchObject({
      converge: false,
      reason: 'previouslyFailed',
    });
  });

  // The failure arm must win over the in-flight arm: a failed file never reaches the terminal count,
  // so classifying it as in-flight would hide it from the owner forever.
  it('classifies a failed member as failed even though its vector rollup is short', () => {
    expect(decideMemberConvergence(member({ error: 'boom', vectorizedChunkCount: 0 }), policy)).toMatchObject({
      converge: false,
      reason: 'previouslyFailed',
    });
  });

  it('waits for a member whose vectorization has not settled', () => {
    expect(
      decideMemberConvergence(member({ vectorizedChunkCount: 3, chunkedPassageTokenTarget: 2100 }), policy)
    ).toMatchObject({ converge: false, reason: 'indexingInFlight' });
  });

  // The kill switch abandons a vectorize by writing this note and clearing isVectorizing; it never
  // sets `error`. Without this arm the member reads as in-flight forever and can never be repaired,
  // which is the state the switch is supposed to be recoverable from.
  it('treats a kill-switch-abandoned member as settled, so it can converge', () => {
    expect(
      decideMemberConvergence(
        member({ notes: CONVERGENCE_PAUSED_NOTE, vectorizedChunkCount: 0, chunkedPassageTokenTarget: 2100 }),
        policy
      )
    ).toMatchObject({ converge: true });
  });

  it('treats a null vector rollup (predating the field) as settled', () => {
    expect(
      decideMemberConvergence(member({ vectorizedChunkCount: null, chunkedPassageTokenTarget: 2100 }), policy)
    ).toMatchObject({ converge: true });
  });

  // The state QA reached by pausing mid-wave: the producer had already deleted this member's
  // passages, so it sits at chunkCount 0 with no error - which every arm below misreads. The reset
  // PRESERVES chunkedPassageTokenTarget and nulls maxChunkCharLength, so a member already repaired
  // to the policy grades `conformant` and nothing ever rebuilds it.
  it('converges a member whose passages a halted wave removed, rather than reading it as conformant', () => {
    expect(
      decideMemberConvergence(
        member({
          chunkCount: 0,
          vectorizedChunkCount: 0,
          maxChunkCharLength: null,
          notes: CONVERGENCE_PAUSED_CHUNK_NOTE,
        }),
        policy
      )
    ).toMatchObject({ converge: true, passagesRemoved: true });
  });

  // A failed read is not a "no". Neither "rewrite it" nor "it is fine" is honest here.
  it('refuses a member with neither fact measured, as unmeasured rather than conformant', () => {
    expect(
      decideMemberConvergence(member({ maxChunkCharLength: null, chunkedPassageTokenTarget: null }), policy)
    ).toMatchObject({ converge: false, reason: 'unmeasured' });
  });

  it('still grades a legacy member with no stamped target when its chunk size is measured', () => {
    expect(
      decideMemberConvergence(member({ chunkedPassageTokenTarget: null, maxChunkCharLength: 9000 }), policy)
    ).toMatchObject({ converge: true, overshootChars: 9000 - policy.policyChars });
    expect(
      decideMemberConvergence(member({ chunkedPassageTokenTarget: null, maxChunkCharLength: 100 }), policy)
    ).toMatchObject({ converge: false, reason: 'conformant' });
  });
});

describe('planLakeConvergence', () => {
  // A member with no passages returns NOTHING today, while an oversized chunk still returns
  // something - and its overshootChars is 0 (there is no chunk to measure), which would otherwise
  // sort the lake's most damaged members to the very back of the wave.
  it('puts members with no passages at all ahead of the worst overshoot', () => {
    const plan = planLakeConvergence(
      [
        member({ fabFileId: 'huge', maxChunkCharLength: 40000, chunkedPassageTokenTarget: null }),
        member({
          fabFileId: 'stranded',
          chunkCount: 0,
          vectorizedChunkCount: 0,
          maxChunkCharLength: null,
          notes: CONVERGENCE_PAUSED_CHUNK_NOTE,
        }),
      ],
      policy
    );

    expect(plan.candidates.map(c => c.fabFileId)).toEqual(['stranded', 'huge']);
  });

  it('excludes chunkless members from the denominator so changeShare is not diluted', () => {
    const plan = planLakeConvergence(
      [
        member({ fabFileId: 'a', chunkedPassageTokenTarget: 2100 }),
        member({ fabFileId: 'img', chunkCount: 0 }),
        member({ fabFileId: 'b' }),
      ],
      policy
    );

    expect(plan.membersConsidered).toBe(2);
    expect(plan.candidates.map(c => c.fabFileId)).toEqual(['a']);
    expect(plan.changeShare).toBe(0.5);
  });

  it('orders the wave worst-first, tie-broken by id so two calls agree on the wave boundary', () => {
    // Unstamped (legacy) members: overshoot is a genuine violation for these, so they all converge
    // and the ordering is what is under test. A stamped-at-target overshoot is terminal instead.
    const overshooting = (fabFileId: string, maxChunkCharLength: number) =>
      member({ fabFileId, maxChunkCharLength, chunkedPassageTokenTarget: null });
    const plan = planLakeConvergence(
      [
        overshooting('small', 4000),
        overshooting('huge', 40000),
        overshooting('b-tie', 9000),
        overshooting('a-tie', 9000),
      ],
      policy
    );

    expect(plan.candidates.map(c => c.fabFileId)).toEqual(['huge', 'a-tie', 'b-tie', 'small']);
  });

  it('tallies every skip reason', () => {
    const plan = planLakeConvergence(
      [
        member({ fabFileId: 'ok' }),
        member({ fabFileId: 'failed', error: 'boom' }),
        member({ fabFileId: 'inflight', vectorizedChunkCount: 1 }),
        member({ fabFileId: 'unknown', maxChunkCharLength: null, chunkedPassageTokenTarget: null }),
        member({ fabFileId: 'irreducible', maxChunkCharLength: 99000 }),
      ],
      policy
    );

    expect(plan.skipped).toEqual({
      conformant: 1,
      previouslyFailed: 1,
      indexingInFlight: 1,
      unmeasured: 1,
      irreducibleOvershoot: 1,
    });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.changeShare).toBe(0);
  });

  it('reports a zero share for a lake with no gradable members rather than dividing by zero', () => {
    const plan = planLakeConvergence([member({ chunkCount: 0 })], policy);
    expect(plan.changeShare).toBe(0);
    expect(Number.isNaN(plan.changeShare)).toBe(false);
  });
});

describe('requiresBulkChangeConfirmation (constraint 4)', () => {
  const planOf = (candidates: number, total: number) =>
    planLakeConvergence(
      Array.from({ length: total }, (_, i) =>
        member({
          fabFileId: `f${i}`,
          chunkedPassageTokenTarget: i < candidates ? 2100 : 512,
        })
      ),
      policy
    );

  it('fires when the share exceeds the threshold', () => {
    expect(requiresBulkChangeConfirmation(planOf(9, 20), 0.25)).toBe(true);
  });

  it('does not fire at or below the threshold', () => {
    expect(requiresBulkChangeConfirmation(planOf(5, 20), 0.25)).toBe(false);
  });

  // 1 of 2 files is 50% and means nothing; the guard exists to catch a MASS rewrite.
  it('does not fire on a lake too small for a share to be meaningful', () => {
    const total = BULK_CHANGE_MIN_MEMBERS - 1;
    expect(requiresBulkChangeConfirmation(planOf(total, total), 0.25)).toBe(false);
  });

  it('does not fire when there is nothing to converge', () => {
    expect(requiresBulkChangeConfirmation(planOf(0, 40), 0)).toBe(false);
  });
});
