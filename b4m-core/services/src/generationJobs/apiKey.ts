import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';

/** Whether a resolveApiKey answer may reach a provider: shared by the create-time check and every job step. */
export const isUsableApiKey = (apiKey: string | null): apiKey is string => !!apiKey && apiKey !== EXPIRED_KEY_SENTINEL;
