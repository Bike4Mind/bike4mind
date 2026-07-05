import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Structural sync check: ensures DLQ_REGISTRY (runtime) and DLQ_DESCRIPTORS (infra)
 * contain the same set of queue labels. Catches drift between the two registries
 * that must be maintained in parallel due to different SST contexts.
 */
describe('DLQ registry sync', () => {
  function extractLabels(filePath: string, arrayName: string): string[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Extract only the array definition block, then find labels within it
    const arrayRegex = new RegExp(`(?:const|let|var)\\s+${arrayName}[^=]*=\\s*\\[([\\s\\S]*?)\\];`);
    const arrayMatch = arrayRegex.exec(content);
    if (!arrayMatch) throw new Error(`Could not find ${arrayName} in ${filePath}`);
    const arrayBlock = arrayMatch[1];
    const labels: string[] = [];
    const labelRegex = /label:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = labelRegex.exec(arrayBlock)) !== null) {
      labels.push(match[1]);
    }
    return labels.sort();
  }

  const repoRoot = path.resolve(__dirname, '../../../../');
  const registryPath = path.join(repoRoot, 'apps/client/server/utils/dlqRegistry.ts');
  const alarmsPath = path.join(repoRoot, 'infra/dlqAlarms.ts');

  it('DLQ_REGISTRY and DLQ_DESCRIPTORS have the same labels', () => {
    const registryLabels = extractLabels(registryPath, 'DLQ_REGISTRY');
    const alarmsLabels = extractLabels(alarmsPath, 'DLQ_DESCRIPTORS');

    expect(registryLabels).toEqual(alarmsLabels);
  });

  it('no duplicate labels in DLQ_REGISTRY', () => {
    const labels = extractLabels(registryPath, 'DLQ_REGISTRY');
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('no duplicate labels in DLQ_DESCRIPTORS', () => {
    const labels = extractLabels(alarmsPath, 'DLQ_DESCRIPTORS');
    expect(new Set(labels).size).toBe(labels.length);
  });
});
