import { configureSecretsAtRest } from '@bike4mind/utils/security';

// Service tests never run connectDB, so nothing loads the at-rest keyring. Load "no key" (secrets
// stay plaintext) so they run as they did before the keyring throws when unloaded.
configureSecretsAtRest(undefined);
