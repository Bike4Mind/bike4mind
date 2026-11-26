import mongoose from 'mongoose';
import { initModelsOnRequest } from '../../packages/database/src/__test__/initModelsOnRequest';
import { configureSecretsAtRest } from '@bike4mind/utils/security';

initModelsOnRequest(mongoose);

// Real-Mongo suites mint and store secrets without going through connectDB, so nothing loads the
// at-rest keyring. Load "no key" (plaintext) so they run as they did before the keyring throws.
configureSecretsAtRest(undefined);
