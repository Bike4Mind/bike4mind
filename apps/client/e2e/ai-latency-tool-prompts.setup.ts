import { setupSpecUser } from './helpers/spec-setup';

// key is camelCase so it matches projectNameToSpecKey('ai-latency-tool-prompts') in fixtures.ts;
// authFile keeps its kebab storageState path (referenced verbatim in playwright.config.ts).
setupSpecUser({ key: 'aiLatencyToolPrompts', authFile: 'ai-latency-tool-prompts-user.json' });
