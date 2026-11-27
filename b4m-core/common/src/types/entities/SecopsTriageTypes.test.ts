import { describe, it, expect } from 'vitest';
import { SecopsTriageConfigFieldsSchema, SecopsTriageConfigSchema } from './SecopsTriageTypes';

const firstIssue = (value: unknown) => {
  const result = SecopsTriageConfigSchema.safeParse(value);
  return result.success ? null : { path: result.error.issues[0].path, message: result.error.issues[0].message };
};

describe('SecopsTriageConfigSchema', () => {
  it('parses an empty object to disabled defaults with no repository', () => {
    expect(SecopsTriageConfigSchema.parse({})).toMatchObject({
      enabled: false,
      githubRepo: '',
      maxIssuesPerScan: 20,
      dryRun: false,
    });
  });

  it.each([undefined, '', 'test-repo', 'test-org/', 'test-org/test-repo/extra', 'test org/test-repo'])(
    'rejects an enabled config with repository %j on githubRepo',
    githubRepo => {
      expect(firstIssue({ enabled: true, githubRepo })).toEqual({
        path: ['githubRepo'],
        message: 'A repository in owner/name form is required when SecOps triage is enabled',
      });
    }
  );

  it.each(['test-org/test-repo', 'test_org/test.repo-2'])('accepts an enabled config with repository %j', repo => {
    expect(SecopsTriageConfigSchema.safeParse({ enabled: true, githubRepo: repo }).success).toBe(true);
  });

  it('allows a disabled config without a repository', () => {
    expect(SecopsTriageConfigSchema.safeParse({ enabled: false, githubRepo: '' }).success).toBe(true);
  });

  it.each([0, 101, Number.NaN])('rejects %s max issues per scan with a readable message', maxIssuesPerScan => {
    expect(firstIssue({ maxIssuesPerScan })).toEqual({
      path: ['maxIssuesPerScan'],
      message: 'Max issues per scan must be between 1 and 100',
    });
  });

  it('requires a model when LLM enrichment is on', () => {
    expect(firstIssue({ llmEnrichment: true })).toEqual({
      path: ['modelId'],
      message: 'A model must be selected when LLM enrichment is enabled',
    });
  });
});

describe('SecopsTriageConfigFieldsSchema', () => {
  it('parses a value that breaks the cross-field rules, keeping its fields', () => {
    const value = { enabled: true, llmEnrichment: true, slackChannelId: 'C123' };

    expect(SecopsTriageConfigSchema.safeParse(value).success).toBe(false);
    expect(SecopsTriageConfigFieldsSchema.parse(value)).toMatchObject({
      enabled: true,
      githubRepo: '',
      llmEnrichment: true,
      slackChannelId: 'C123',
    });
  });

  it('still rejects a field of the wrong type', () => {
    expect(SecopsTriageConfigFieldsSchema.safeParse({ maxIssuesPerScan: 'many' }).success).toBe(false);
  });
});
