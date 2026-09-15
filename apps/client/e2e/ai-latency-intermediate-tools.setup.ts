import { setupSpecUser } from './helpers/spec-setup';

// key is camelCase so it matches projectNameToSpecKey('ai-latency-intermediate-tools') in fixtures.ts;
// authFile keeps its kebab storageState path (referenced verbatim in playwright.config.ts).
setupSpecUser({ key: 'aiLatencyIntermediateTools', authFile: 'ai-latency-intermediate-tools-user.json' });
