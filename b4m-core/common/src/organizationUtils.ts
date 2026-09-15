import { parseInternalStaffDomains, parseInternalOrgDisplayNames } from './utils/internalStaffDomains';

/** Title-case a domain's second-level label, e.g. `acme.co.uk` -> "Acme". */
const titleCaseDomainLabel = (fullDomain: string): string => {
  const label = fullDomain.split('.')[0];
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Unknown';
};

/**
 * Infer a display org name from an email for analytics grouping (weekly report `topOrganizations`).
 * Internal staff resolve from NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS (same source as the #172 count);
 * their label comes from the NEXT_PUBLIC_INTERNAL_ORG_DISPLAY_NAMES map, else the title-cased domain
 * — no hardcoded brand literal (#350). Config defaults from env; `options` overrides for tests.
 */
export const inferOrganizationFromEmail = (
  email: string | undefined,
  options?: {
    internalStaffDomains?: string[];
    internalOrgDisplayNames?: Record<string, string>;
  }
): string => {
  if (!email) return 'Unknown';
  const fullDomain = email.split('@')[1]?.toLowerCase();
  if (!fullDomain) return 'Unknown';

  const internalStaffDomains =
    options?.internalStaffDomains ?? parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS);
  if (internalStaffDomains.includes(fullDomain)) {
    const displayNames =
      options?.internalOrgDisplayNames ??
      parseInternalOrgDisplayNames(process.env.NEXT_PUBLIC_INTERNAL_ORG_DISPLAY_NAMES);
    return displayNames[fullDomain] ?? titleCaseDomainLabel(fullDomain);
  }

  if (isPersonalEmail(email)) return 'Personal';

  return titleCaseDomainLabel(fullDomain);
};

export const personalEmailProviders = [
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'live.com',
  'msn.com',
  'protonmail.com',
  'yandex.com',
  'zoho.com',
  'mail.com',
  'gmx.com',
  'inbox.com',
  'fastmail.com',
  'hushmail.com',
  'tutanota.com',
  'runbox.com',
];

export const isPersonalEmail = (email: string | undefined): boolean => {
  if (!email) return false;
  const domain = email.split('@')[1];
  return personalEmailProviders.includes(domain);
};
