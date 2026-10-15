import { isMetaPixelConfigured, loadMetaPixel } from './metaPixel';
import { isRedditPixelConfigured, loadRedditPixel } from './redditPixel';
import { loadMailerLite } from './mailerLite';

export type ConsentVendor = {
  category: 'analytics' | 'advertising' | 'email marketing';
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
    isConfigured: () => Boolean(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID),
  },
  { category: 'advertising', name: 'Meta', isConfigured: isMetaPixelConfigured, load: loadMetaPixel },
  { category: 'advertising', name: 'Reddit', isConfigured: isRedditPixelConfigured, load: loadRedditPixel },
  { category: 'email marketing', name: 'MailerLite', isConfigured: () => true, load: loadMailerLite },
];

export function loadConsentVendors(): void {
  for (const vendor of CONSENT_VENDORS) vendor.load?.();
}
