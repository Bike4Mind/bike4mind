import { registerContributedSettings } from '@bike4mind/common';
import { premiumAdminSettings } from '@client/app/premium-generated/premiumAdminSettings.generated';

// Imported for its side effect by baseApi, the admin settings context, and every generated server
// handler stub, so a contributed setting resolves however the process was entered.
const { coreCollisions, duplicates, rejected } = registerContributedSettings(premiumAdminSettings);
if (coreCollisions.length > 0) {
  console.warn('Dropped contributed admin settings whose key a core setting already defines', coreCollisions);
}
if (duplicates.length > 0) {
  console.warn('Dropped contributed admin settings whose key was already contributed', duplicates);
}
if (rejected.length > 0) {
  console.warn('Dropped contributed admin settings with a retired, reserved or missing key', rejected);
}
