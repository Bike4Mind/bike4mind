import { setupSpecUser } from './helpers/spec-setup';

// key is camelCase so it matches projectNameToSpecKey('ai-latency-long-answers') in fixtures.ts;
// authFile keeps its kebab storageState path (referenced verbatim in playwright.config.ts).
setupSpecUser({ key: 'aiLatencyLongAnswers', authFile: 'ai-latency-long-answers-user.json' });
