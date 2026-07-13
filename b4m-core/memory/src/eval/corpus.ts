/**
 * The eval corpus: a synthetic persona with hand-authored, deliberately HARD cases.
 *
 * Synthetic on purpose, and not negotiable: this repo is public, so a corpus built from a real user's
 * memory would publish their private facts. A fictional persona also buys something a real corpus
 * cannot - control. We get to author the near-misses, the contradictions, and the questions whose
 * answers are simply absent, which is where a retrieval policy actually breaks.
 *
 * Design rules for the queries, because an easy corpus proves nothing:
 *
 * 1. POSITIVES share almost no vocabulary with their belief. "What shade should I paint the trim?"
 *    against "favorite color is teal" has zero content-word overlap: lexical retrieval scores it 0,
 *    so any hit is real semantic retrieval. This is exactly the axis V2 was built to win.
 * 2. NEGATIVES are near-misses, not nonsense. "What breed is the dog?" when the persona keeps
 *    clownfish; "which university does she teach at?" when she merely studied at one. A policy with
 *    no topicality floor will hand the model the adjacent belief and invite it to confabulate.
 * 3. CONTRADICTIONS are stated twice, the later one superseding, to test that recency wins.
 */

import type { Belief } from '../types';

export interface EvalBelief {
  id: string;
  fact: string;
  /** Hours before "now" that this fact was last presented; drives ACT-R activation in the eval. */
  ageHours: number;
  /** How many times it has been presented (an assert + N affirms). Exercises the frequency term. */
  presentations: number;
}

export interface EvalQuery {
  id: string;
  query: string;
  /** Belief ids that genuinely answer this query. Empty = a NEGATIVE: nothing in memory answers it. */
  relevant: string[];
  /** Why this query is hard - documentation, not used by the scorer. */
  note?: string;
}

export const CORPUS_BELIEFS: EvalBelief[] = [
  { id: 'color', fact: 'Dana said her favorite color is teal.', ageHours: 300, presentations: 1 },
  { id: 'allergy', fact: 'Dana is severely allergic to shellfish.', ageHours: 500, presentations: 3 },
  { id: 'job', fact: 'Dana works as a marine biologist studying coral reef restoration.', ageHours: 20, presentations: 6 },
  { id: 'baking', fact: 'Dana bakes sourdough bread on weekends.', ageHours: 100, presentations: 2 },
  { id: 'daughter', fact: 'Dana has a seven-year-old daughter named Mira.', ageHours: 60, presentations: 4 },
  { id: 'car', fact: 'Dana drives a 2019 Subaru Outback.', ageHours: 900, presentations: 1 },
  { id: 'language', fact: 'Dana is learning Portuguese ahead of a research trip to Brazil.', ageHours: 40, presentations: 2 },
  { id: 'schedule', fact: 'Dana prefers morning meetings and keeps afternoons free for deep work.', ageHours: 15, presentations: 5 },
  { id: 'phd', fact: 'Dana earned her PhD at Scripps Institution of Oceanography.', ageHours: 1200, presentations: 1 },
  { id: 'aquarium', fact: 'Dana keeps a saltwater aquarium with two clownfish.', ageHours: 200, presentations: 2 },
  { id: 'marathon', fact: 'Dana ran the Boston Marathon in 2023.', ageHours: 700, presentations: 1 },
  { id: 'mother', fact: "Dana's mother lives in Lisbon.", ageHours: 400, presentations: 1 },
  { id: 'desk', fact: 'Dana uses a standing desk because of chronic lower back pain.', ageHours: 80, presentations: 3 },
  { id: 'slack', fact: "Dana's team communicates on Slack rather than Teams.", ageHours: 30, presentations: 2 },
  { id: 'coffee', fact: 'Dana drinks only decaf after noon.', ageHours: 120, presentations: 1 },
];

/**
 * A later, superseding statement of `color`. Same subject, newer, different value - a fold must let
 * the newer one win, and recall must not surface the stale one alongside it.
 */
export const CONTRADICTION: EvalBelief = {
  id: 'color',
  fact: 'Dana now says her favorite color is burnt orange, not teal.',
  ageHours: 5,
  presentations: 1,
};

export const CORPUS_QUERIES: EvalQuery[] = [
  // --- POSITIVES: near-zero lexical overlap with the belief they must retrieve ---
  { id: 'q-color-1', query: 'What shade should I paint the trim if I want to please her?', relevant: ['color'], note: 'shade vs color; no shared content word' },
  { id: 'q-allergy-1', query: 'Is there anything I must keep off the menu at the seafood place?', relevant: ['allergy'], note: 'no "allergy" or "shellfish"' },
  { id: 'q-job-1', query: 'How does she earn a living?', relevant: ['job'] },
  { id: 'q-job-2', query: 'Which ecosystems does her research concern?', relevant: ['job'], note: 'ecosystem vs coral reef' },
  { id: 'q-baking-1', query: 'Does she have a hobby involving flour and an oven?', relevant: ['baking'], note: 'flour/oven vs sourdough' },
  { id: 'q-daughter-1', query: 'Does she have any children?', relevant: ['daughter'] },
  { id: 'q-car-1', query: 'What does she drive to work?', relevant: ['car'] },
  { id: 'q-language-1', query: 'Is she picking up a new tongue for an upcoming journey?', relevant: ['language'], note: 'tongue/journey vs language/trip' },
  { id: 'q-schedule-1', query: 'When should I book a call so she is at her sharpest?', relevant: ['schedule'] },
  { id: 'q-phd-1', query: 'Where did she do her doctoral work?', relevant: ['phd'] },
  { id: 'q-aquarium-1', query: 'Does she look after any animals at home?', relevant: ['aquarium'], note: 'animals/home vs aquarium/clownfish' },
  { id: 'q-marathon-1', query: 'Has she ever done anything in endurance sport?', relevant: ['marathon'], note: 'endurance sport vs marathon' },
  { id: 'q-mother-1', query: 'Whereabouts is her family based?', relevant: ['mother'] },
  { id: 'q-desk-1', query: 'Any physical issues I should accommodate at her workstation?', relevant: ['desk'], note: 'physical issue vs back pain' },
  { id: 'q-slack-1', query: 'Which messaging tool will reach her team?', relevant: ['slack'] },
  { id: 'q-coffee-1', query: 'Can I offer her an espresso after lunch?', relevant: ['coffee'], note: 'espresso/after lunch vs decaf/after noon' },

  // --- NEGATIVES: near-misses. Nothing in memory answers these. ---
  { id: 'n-dog', query: 'What breed is her dog?', relevant: [], note: 'she keeps clownfish - the adjacent pet belief is the bait' },
  { id: 'n-teach', query: 'Which university does she teach at?', relevant: [], note: 'she STUDIED at Scripps; teaching is not in memory' },
  { id: 'n-salary', query: 'What is her salary?', relevant: [] },
  { id: 'n-siblings', query: 'How many brothers and sisters does she have?', relevant: [], note: 'family belief exists (mother) but does not answer this' },
  { id: 'n-blood', query: 'What is her blood type?', relevant: [] },
  { id: 'n-honeymoon', query: 'Where did she go on her honeymoon?', relevant: [], note: 'travel belief exists (Brazil) but does not answer this' },
  { id: 'n-guitar', query: 'What guitar does she play?', relevant: [], note: 'hobby beliefs exist (baking, running) - none is music' },
];

const HOUR_MS = 3_600_000;

/**
 * Materialise the corpus as folded `Belief`s as of `nowMs`, with an ACT-R activation consistent with
 * each fact's age and presentation count. The embeddings are supplied by the caller (they come from a
 * real provider - fake vectors would prove nothing about semantic retrieval).
 */
export function buildBeliefs(
  corpus: readonly EvalBelief[],
  embeddings: Record<string, number[]>,
  nowMs: number,
  activationOf: (presentationTimesMs: number[], nowMs: number) => number
): Belief[] {
  return corpus.map(b => {
    // Spread the presentations back in time from lastSeen, one per day, so frequency and recency
    // both have something to bite on.
    const lastSeen = nowMs - b.ageHours * HOUR_MS;
    const times = Array.from({ length: b.presentations }, (_, i) => lastSeen - i * 24 * HOUR_MS);
    return {
      id: b.id,
      fact: b.fact,
      evidenceTier: 'engineering-proxy' as const,
      confidence: 0.6,
      activation: activationOf(times, nowMs),
      embedding: embeddings[b.id],
      derivedFrom: [],
      lastAffirmedAt: new Date(lastSeen).toISOString(),
    };
  });
}
