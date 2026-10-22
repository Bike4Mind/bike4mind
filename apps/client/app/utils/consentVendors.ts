import { isMetaPixelConfigured, loadMetaPixel } from './metaPixel';
import { isRedditPixelConfigured, loadRedditPixel } from './redditPixel';
import { getGaMeasurementId } from './gaConsentBootstrap';

export type ConsentVendor = {
  category: 'analytics' | 'advertising';
  name: string;
  isConfigured: () => boolean;
  /** Injects the vendor's script on a grant. Absent when consent is applied another way. */
  load?: () => void;
};

/**
 * Every third party a cookie-consent grant switches on. The banner names exactly the configured
 * entries and the grant runs exactly their loaders, so a vendor cannot load without being named.
 * Listed in the order the banner names them.
 */
export const CONSENT_VENDORS: readonly ConsentVendor[] = [
  // Loaded by the gtag tag in app/layout.tsx and switched by consent mode, not by a loader.
  {
    category: 'analytics',
    name: 'Google Analytics',
    isConfigured: () => Boolean(getGaMeasurementId()),
  },
  { category: 'advertising', name: 'Meta', isConfigured: isMetaPixelConfigured, load: loadMetaPixel },
  { category: 'advertising', name: 'Reddit', isConfigured: isRedditPixelConfigured, load: loadRedditPixel },
];

/** Runs the loader of every configured vendor - the same set the banner names. */
export function loadConsentVendors(): void {
  for (const vendor of CONSENT_VENDORS) if (vendor.isConfigured()) vendor.load?.();
}
