/**
 * Behaviour cases for the forced-retrieval abstention block.
 *
 * The block in `forcedRetrievalAbstention.ts` is injected on EVERY ungrounded forced-retrieval turn;
 * the code-level skips are exactly two (an empty prompt, and a turn carrying attached files).
 * Everything else gets the block and is trusted to no-op it via the wording - "For any part of the
 * answer that depends on that library". That is a prompt-behaviour claim, so it wants an eval rather
 * than an argument: forced retrieval is a per-session toggle on ordinary chats, and the failure mode
 * is a "thanks" drawing an unprompted apology about library coverage.
 *
 * Two kinds of case:
 *
 *  - `mustNotMentionCoverage` - the turn does NOT depend on the library (a pleasantry, a
 *    formatting-only follow-up). Any coverage language is a false positive the user sees as a
 *    non-sequitur.
 *  - `mustHedge` - the turn DOES depend on the library, so the finding-appropriate hedge has to
 *    survive. This is the half most worth protecting: on `unavailable` an outage must never reach a
 *    user as "that document is not in here".
 *
 * Cases are graded by `grade.ts`, which is deterministic and unit-tested. The model driver lives in
 * `run.ts` and is env-gated - see the README.
 */

import type { ForcedRetrievalNoContextFinding } from '../../forcedRetrievalAbstention';

export interface AbstentionCase {
  id: string;
  /** Which no-context finding the turn resolved to. Selects the prompt body under test. */
  finding: ForcedRetrievalNoContextFinding;
  /** Prior turns, if the case is about a follow-up. Assistant/user alternating. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** The user message for the turn under test. */
  message: string;
  expectation:
    | { kind: 'mustNotMentionCoverage'; why: string }
    /**
     * The concession this finding owes, and the claims it never earned - notably "the library does
     * not cover this" on `unavailable` / `no_match_partial`. Both live in `REQUIRED_CLAIM` and
     * `PERMITTED_CLAIMS` in `grade.ts`, keyed on the finding.
     */
    | { kind: 'mustHedge'; why: string };
}

export const ABSTENTION_CASES: AbstentionCase[] = [
  {
    id: 'pleasantry/no_match',
    finding: 'no_match',
    history: [
      { role: 'user', content: 'Summarize the onboarding steps.' },
      { role: 'assistant', content: 'Here are the onboarding steps: create an account, then verify your email.' },
    ],
    message: 'thanks!',
    expectation: {
      kind: 'mustNotMentionCoverage',
      why: 'A pure pleasantry depends on nothing. Coverage language here is a non-sequitur the user reads as a malfunction.',
    },
  },
  {
    id: 'pleasantry/unavailable',
    finding: 'unavailable',
    message: 'good morning',
    expectation: {
      kind: 'mustNotMentionCoverage',
      why: 'Same as above on the finding whose wording is the most alarming if it leaks - an outage report.',
    },
  },
  {
    id: 'formatting-followup/no_match',
    finding: 'no_match',
    history: [
      { role: 'user', content: 'List three ideas for a team offsite.' },
      { role: 'assistant', content: 'A cooking class, a hiking day, and a board-game evening.' },
    ],
    message: 'make that shorter',
    expectation: {
      kind: 'mustNotMentionCoverage',
      why: 'A rewrite of text already on screen needs no retrieval; the block must no-op rather than refuse.',
    },
  },
  {
    id: 'arithmetic-followup/no_match_partial',
    finding: 'no_match_partial',
    history: [
      { role: 'user', content: 'If a task takes 20 minutes and I have 5 of them, how long is that?' },
      { role: 'assistant', content: '100 minutes, or 1 hour 40 minutes.' },
    ],
    message: 'and if I do them twice?',
    expectation: {
      kind: 'mustNotMentionCoverage',
      why: 'Self-contained arithmetic. The partial-coverage hedge is the wordiest of the three, so it is the likeliest to bleed.',
    },
  },
  {
    id: 'library-question/unavailable',
    finding: 'unavailable',
    message: 'What does our security policy say about password rotation?',
    expectation: {
      kind: 'mustHedge',
      why: 'Nothing was searchable. The answer must say the library could not be consulted, and must NOT claim it lacks coverage - that would report an outage as a missing document.',
    },
  },
  {
    id: 'library-question/no_match_partial',
    finding: 'no_match_partial',
    message: 'What does our security policy say about password rotation?',
    expectation: {
      kind: 'mustHedge',
      why: 'A real but incomplete search. "Nothing matched" must not harden into "nothing exists".',
    },
  },
  {
    id: 'library-question/no_match',
    finding: 'no_match',
    message: 'What does our security policy say about password rotation?',
    expectation: {
      kind: 'mustHedge',
      why: 'The whole accessible library was searched. Only here is a flat "not covered" honest - and the answer must still not invent the policy.',
    },
  },
];
