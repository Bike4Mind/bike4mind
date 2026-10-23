import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Each transport must opt into durable billing; the core keeps the adapter optional for external consumers.
describe('hosted completion credit hold wiring', () => {
  it.each([
    '../chatCompletion/external/sseRoute.ts',
    '../chatCompletion/external/wsRoute.ts',
    '../chatCompletion/external/embedRoute.ts',
    '../websocket/cliCompletion.ts',
  ])('%s supplies a new durable lifecycle for each completion', route => {
    const source = readFileSync(fileURLToPath(new URL(route, import.meta.url)), 'utf8');
    const completions = source.match(/executeCompletion\(\{[^]*?\buserId\b/g) ?? [];
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatch(/creditHolds: createCompletionCreditHolds\(logger\)/);
    expect(source).toContain("from '@server/billing/completionCreditHolds'");
  });
});
