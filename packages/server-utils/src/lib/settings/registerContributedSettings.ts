import { registerContributedSettings } from '@bike4mind/common';
import { premiumAdminSettings } from '../../premium-generated/premiumAdminSettings.generated';

// Imported for its side effect by each entrypoint that reads settings outside baseApi (the admin
// settings context, generated server handler stubs, the queue and job handlers that import it, and
// every server module that loads generated extension-code glue - pinned by baseApi.registration.test.ts).
// A process entered anywhere else sees only the core catalog.
const { coreCollisions, duplicates, rejected } = registerContributedSettings(premiumAdminSettings);
if (coreCollisions.length > 0) {
  console.warn('Dropped contributed admin settings whose key a core setting already defines', coreCollisions);
}
if (duplicates.length > 0) {
  console.warn('Dropped contributed admin settings whose key was already contributed', duplicates);
}
if (rejected.length > 0) {
  console.warn(
    'Dropped contributed admin settings that failed validation (reserved or missing key, no schema, a sensitive default, or a scope)',
    rejected
  );
}
