export const inferOrganizationFromEmail = (email: string | undefined): string => {
  if (!email) return 'Unknown';
  const domain = email.split('@')[1]?.split('.')[0];
  if (domain?.includes('milliononmars')) {
    return 'Million on Mars';
  } else if (isPersonalEmail(email)) {
    return 'Personal';
  } else {
    const parts = domain?.split('.') || [];
    const cleanDomain = parts.length > 1 ? parts[parts.length - 2] : parts[0];
    return cleanDomain?.charAt(0).toUpperCase() + cleanDomain?.slice(1) || 'Unknown';
  }
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
