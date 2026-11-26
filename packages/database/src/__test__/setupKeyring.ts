import { configureSecretsAtRest } from '@bike4mind/utils/security';

// Model tests use the unwrapped connectDB, so nothing loads the at-rest keyring for them. Load
// "no key" (secrets stay plaintext) so they run as they did before the keyring throws when unloaded.
configureSecretsAtRest(undefined);
