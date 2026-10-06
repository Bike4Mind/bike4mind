// conformance.ts is deliberately not exported: it imports vitest and must stay out of the published bundle.
// Adapter tests import it by relative path.
export * from './types';
export * from './registry';
export { TestVideoProvider } from './test/TestVideoProvider';
