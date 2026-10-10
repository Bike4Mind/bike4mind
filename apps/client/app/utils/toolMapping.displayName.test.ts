import { describe, expect, it } from 'vitest';
import { premiumToolDisplayLabels } from '@client/app/premium-generated/premiumToolDisplayLabels.generated';
import { getToolDisplayName, humanizeToolId, TOOL_MAPPING } from './toolMapping';

describe('humanizeToolId', () => {
  it('drops a leading namespace segment and title-cases the rest', () => {
    expect(humanizeToolId('acme_run_batch_job')).toBe('Run Batch Job');
    expect(humanizeToolId('acme-solve.model')).toBe('Solve Model');
  });

  it('keeps a single-word id whole', () => {
    expect(humanizeToolId('lookup')).toBe('Lookup');
  });

  it('never returns a snake_case id', () => {
    expect(humanizeToolId('ACME_DEEP_SCAN')).toBe('Deep Scan');
  });

  it('keeps the verb of a core tool that TOOL_MAPPING does not list', () => {
    expect(humanizeToolId('edit_image')).toBe('Edit Image');
    expect(humanizeToolId('count_knowledge_base')).not.toBe(humanizeToolId('describe_knowledge_base'));
  });

  it('treats a colon as a separator, as in MCP server:tool ids', () => {
    expect(humanizeToolId('github:create_issue')).toBe('Create Issue');
  });
});

describe('getToolDisplayName', () => {
  it("keeps a core tool's own name, even when an overlay labels the same id", () => {
    expect(getToolDisplayName('web_search', { web_search: 'Renamed' })).toBe('Web Search');
  });

  it('uses the label an overlay contributed for its tool', () => {
    expect(getToolDisplayName('acme_run_batch_job', { acme_run_batch_job: 'Batch Runner' })).toBe('Batch Runner');
  });

  it('humanizes a tool no one labels', () => {
    expect(getToolDisplayName('acme_run_batch_job', {})).toBe('Run Batch Job');
  });

  it('ignores inherited keys on the label table', () => {
    expect(getToolDisplayName('constructor', {})).toBe('Constructor');
  });
});

describe('premiumToolDisplayLabels', () => {
  // Empty in an open-core build; in an overlay build this keeps contributed labels distinct from core.
  const coreNames = new Set(Object.values(TOOL_MAPPING).map(info => info.displayName));

  it('does not shadow a core tool id or display name', () => {
    for (const [toolId, label] of Object.entries(premiumToolDisplayLabels)) {
      expect(Object.hasOwn(TOOL_MAPPING, toolId), toolId).toBe(false);
      expect(coreNames.has(label), label).toBe(false);
    }
  });
});
