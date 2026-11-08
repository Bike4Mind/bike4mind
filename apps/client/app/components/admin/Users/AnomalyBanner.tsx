import type { SignupAnomalySnapshot } from '@bike4mind/server-utils/app/utils/signupAnomaly';
import { AnomalyBanner as SharedAnomalyBanner } from '../shared/AnomalyBanner';

function headline(snapshot: SignupAnomalySnapshot): string {
  if (snapshot.signupSpike) {
    const domain = snapshot.topDomain ? `, mostly @${snapshot.topDomain}` : '';
    return `Signup spike: ${snapshot.signupCount.toLocaleString()} new accounts in the last hour${domain}`;
  }
  if (snapshot.apiKeySpike) return `API key spike: ${snapshot.apiKeyCount.toLocaleString()} new keys in the last hour`;
  return 'Signup scan limit reached';
}

/**
 * Shown only while the last hour looks abnormal. Dismissing hides it for this snapshot window only:
 * the next scan that still flags a spike shows it again.
 */
export function AnomalyBanner({ snapshot, onReview }: { snapshot?: SignupAnomalySnapshot; onReview: () => void }) {
  if (!snapshot || (!snapshot.signupSpike && !snapshot.apiKeySpike && !snapshot.truncated)) return null;
  return (
    <SharedAnomalyBanner
      headline={headline(snapshot)}
      detail={
        `${snapshot.signupCount.toLocaleString()} signups and ${snapshot.apiKeyCount.toLocaleString()} new API keys in the last hour.` +
        (snapshot.truncated ? ' Scan limit reached; counts and domain ranking are partial.' : '')
      }
      actionLabel="Review cluster"
      onAction={onReview}
      dismissKey={snapshot.since}
      testId="users-anomaly-banner"
      actionTestId="users-review-cluster-btn"
      dismissTestId="users-dismiss-anomaly-btn"
    />
  );
}
