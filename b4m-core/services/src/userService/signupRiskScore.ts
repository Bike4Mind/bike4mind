import type { SignupRiskScoring, SignupRiskSignal } from '@bike4mind/common';

/** What is known about a new account. An unknown (null or absent) fact never raises the score. */
export interface SignupRiskFacts {
  email: string;
  /** The email domain is disposable, blocklisted or newly registered. */
  riskyDomain?: boolean | null;
  /** The account belongs to a held signup burst. */
  burstCohort?: boolean | null;
  /** The signup came from a hosting or datacenter network (`signupMeta.isDatacenter`). */
  isDatacenter?: boolean | null;
  /** Minutes from signup to the first API key; null when no key was minted. */
  minutesToFirstApiKey?: number | null;
  /** Credits spent in the first 24 hours after signup. */
  creditsSpentFirst24h?: number | null;
}

export interface SignupRiskContribution {
  signal: SignupRiskSignal;
  points: number;
  /** Shown to the reviewer, so it names the evidence rather than the weight. */
  reason: string;
}

export interface SignupRiskScore {
  /** 0-100. */
  score: number;
  signals: SignupRiskContribution[];
  needsReview: boolean;
}

// Letters, then a digit-led hex suffix with at least one a-f letter (name28af6a): a counter rendered
// in hex. A human's name1985 has no a-f, so it stays out.
const GENERATED_LOCAL_PART = /^[a-z]+?([0-9][0-9a-f]{3,11})$/i;

export function looksGeneratedLocalPart(email: string): boolean {
  const match = GENERATED_LOCAL_PART.exec(email.split('@')[0] ?? '');
  return match !== null && /[a-f]/i.test(match[1]);
}

/**
 * Combines weak signals into one 0-100 score with the configured weights. Pure: the caller gathers
 * the facts. Each signal adds its weight once (fastSpend scales with the credits spent), the total
 * is capped at 100, and a weight of 0 turns a signal off.
 */
export function scoreSignupRisk(facts: SignupRiskFacts, scoring: SignupRiskScoring): SignupRiskScore {
  const signals: SignupRiskContribution[] = [];
  const add = (signal: SignupRiskSignal, fraction: number, reason: string) => {
    const points = Math.round(scoring.weights[signal] * fraction);
    if (points > 0) signals.push({ signal, points, reason });
  };

  if (facts.riskyDomain) add('riskyDomain', 1, 'Disposable, blocklisted or newly registered email domain');
  if (facts.burstCohort) add('burstCohort', 1, 'Part of a held signup burst');
  if (facts.isDatacenter) add('datacenterNetwork', 1, 'Signed up from a hosting or datacenter network');
  const minutes = facts.minutesToFirstApiKey;
  if (minutes != null && minutes >= 0 && minutes <= scoring.quickApiKeyMinutes) {
    add('quickApiKey', 1, `First API key created ${Math.round(minutes)} minutes after signup`);
  }
  const spent = facts.creditsSpentFirst24h;
  if (spent != null && Number.isFinite(spent) && spent > 0) {
    add(
      'fastSpend',
      Math.min(1, spent / scoring.fastSpendCredits),
      `${Math.round(spent)} credits spent in the first 24 hours`
    );
  }
  if (looksGeneratedLocalPart(facts.email)) add('generatedLocalPart', 1, 'Email address looks generated');

  const score = Math.min(
    100,
    signals.reduce((sum, { points }) => sum + points, 0)
  );
  return { score, signals, needsReview: score >= scoring.reviewThreshold };
}
