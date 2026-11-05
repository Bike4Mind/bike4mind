import type { ShadowDetector } from '@bike4mind/common';

/** Display names for the abuse detectors: the Detections page, the AI advisory strip and badge. */
export const DETECTOR_LABELS: Record<ShadowDetector, string> = {
  signupNetworkBurst: 'Signup network burst',
  accountCampaign: 'Account campaign',
  youngAccountSpend: 'Young-account spend',
  paymentRisk: 'Payment risk',
};
