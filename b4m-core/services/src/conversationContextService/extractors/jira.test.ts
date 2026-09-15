import { describe, it, expect } from 'vitest';
import { JiraExtractor } from './jira';

describe('JiraExtractor', () => {
  const extractor = new JiraExtractor();

  describe('extract', () => {
    it('extracts Jira issue key format (PROJECT-123)', () => {
      const text = 'Working on PROJ-123 today';
      const result = extractor.extract(text, 'user');

      expect(result.entities).toHaveLength(2); // Issue + Project
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'jira_issue',
          entity: { key: 'PROJ-123' },
        },
        source: 'user',
      });
      expect(result.entities[1]).toMatchObject({
        entity: {
          type: 'jira_project',
          entity: { key: 'PROJ' },
        },
        source: 'user',
      });
    });

    it('extracts Jira issue URL', () => {
      const text = 'See https://company.atlassian.net/browse/TEAM-456';
      const result = extractor.extract(text, 'tool_result');

      expect(result.entities).toHaveLength(2);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'jira_issue',
          entity: { key: 'TEAM-456' },
        },
        source: 'tool_result',
      });
    });

    it('extracts Jira project URL', () => {
      const text = 'Project at https://acme.atlassian.net/jira/software/projects/DEV';
      const result = extractor.extract(text, 'assistant');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'jira_project',
          entity: { key: 'DEV' },
        },
        source: 'assistant',
      });
    });

    it('extracts project from context mention', () => {
      const text = 'Create a ticket in project BACKEND';
      const result = extractor.extract(text, 'user');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'jira_project',
          entity: { key: 'BACKEND' },
        },
        source: 'user',
      });
    });

    it('handles multiple issues in same text', () => {
      const text = 'PROJ-1 depends on PROJ-2 and TEAM-3';
      const result = extractor.extract(text, 'user');

      const issues = result.entities.filter(e => e.entity.type === 'jira_issue');
      expect(issues).toHaveLength(3);
    });

    it('deduplicates projects from multiple issues', () => {
      const text = 'PROJ-1, PROJ-2, PROJ-3';
      const result = extractor.extract(text, 'user');

      const projects = result.entities.filter(e => e.entity.type === 'jira_project');
      expect(projects).toHaveLength(1); // Only one PROJ project
    });

    it('handles project keys with numbers', () => {
      const text = 'Working on B4M-123';
      const result = extractor.extract(text, 'user');

      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'jira_issue',
          entity: { key: 'B4M-123' },
        },
      });
    });
  });
});
