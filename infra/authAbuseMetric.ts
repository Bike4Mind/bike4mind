export function oauthSignupsRefusedMetricName(stage: string): string {
  // Preserve production history while isolating stages sharing an AWS account.
  return stage === 'production' ? 'OAuthSignupsRefused' : `OAuthSignupsRefused-${stage}`;
}
