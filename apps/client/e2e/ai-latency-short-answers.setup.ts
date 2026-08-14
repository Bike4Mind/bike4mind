import { setupSpecUser } from './helpers/spec-setup';

// key is camelCase so it matches projectNameToSpecKey('ai-latency-short-answers') in fixtures.ts;
// authFile keeps its kebab storageState path (referenced verbatim in playwright.config.ts).
setupSpecUser({ key: 'aiLatencyShortAnswers', authFile: 'ai-latency-short-answers-user.json' });
