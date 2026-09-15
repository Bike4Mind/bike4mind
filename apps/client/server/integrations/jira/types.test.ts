import { describe, it, expect } from 'vitest';
import { extractIssueInfo, matchesFilters, ExtractedIssueInfo } from './types';

// extractIssueInfo

describe('extractIssueInfo', () => {
  it('should extract issue info from a standard issue payload', () => {
    const payload = {
      issue: {
        key: 'PROJ-123',
        fields: {
          summary: 'Fix login bug',
          project: { key: 'PROJ', name: 'Project' },
          issuetype: { name: 'Bug' },
          priority: { name: 'High' },
        },
      },
    };

    const result = extractIssueInfo(payload);

    expect(result).toEqual({
      projectKey: 'PROJ',
      issueKey: 'PROJ-123',
      issueType: 'Bug',
      priority: 'High',
      summary: 'Fix login bug',
    });
  });

  it('should return null when no issue in payload', () => {
    const payload = {
      webhookEvent: 'issuelink_created',
      issueLink: { id: 1 },
    };

    const result = extractIssueInfo(payload);

    expect(result).toBeNull();
  });

  it('should return null when issue has no fields', () => {
    const payload = {
      issue: { key: 'PROJ-1' },
    };

    const result = extractIssueInfo(payload);

    expect(result).toBeNull();
  });

  it('should handle missing priority gracefully', () => {
    const payload = {
      issue: {
        key: 'PROJ-1',
        fields: {
          summary: 'Task',
          project: { key: 'PROJ' },
          issuetype: { name: 'Task' },
        },
      },
    };

    const result = extractIssueInfo(payload);

    expect(result).not.toBeNull();
    expect(result!.priority).toBeUndefined();
  });

  it('should handle missing project key', () => {
    const payload = {
      issue: {
        key: 'PROJ-1',
        fields: {
          summary: 'Task',
          project: {},
          issuetype: { name: 'Task' },
        },
      },
    };

    const result = extractIssueInfo(payload);

    expect(result).not.toBeNull();
    expect(result!.projectKey).toBe('');
  });
});

// matchesFilters

describe('matchesFilters', () => {
  const baseIssue: ExtractedIssueInfo = {
    projectKey: 'PROJ',
    issueKey: 'PROJ-123',
    issueType: 'Bug',
    priority: 'High',
    summary: 'Test issue',
  };

  const emptyFilters = {
    projectFilter: [] as string[],
    priorityFilter: [] as string[],
    issueTypeFilter: [] as string[],
  };

  it('should match when all filters are empty (accept all)', () => {
    const result = matchesFilters(baseIssue, emptyFilters);
    expect(result).toBe(true);
  });

  // Project filter
  describe('projectFilter', () => {
    it('should match when project is in filter', () => {
      const result = matchesFilters(baseIssue, {
        ...emptyFilters,
        projectFilter: ['PROJ', 'OTHER'],
      });
      expect(result).toBe(true);
    });

    it('should not match when project is not in filter', () => {
      const result = matchesFilters(baseIssue, {
        ...emptyFilters,
        projectFilter: ['OTHER', 'ANOTHER'],
      });
      expect(result).toBe(false);
    });

    it('should match all projects when filter is empty', () => {
      const result = matchesFilters(baseIssue, emptyFilters);
      expect(result).toBe(true);
    });
  });

  // Priority filter
  describe('priorityFilter', () => {
    it('should match when priority is in filter', () => {
      const result = matchesFilters(baseIssue, {
        ...emptyFilters,
        priorityFilter: ['High', 'Medium'],
      });
      expect(result).toBe(true);
    });

    it('should not match when priority is not in filter', () => {
      const result = matchesFilters(baseIssue, {
        ...emptyFilters,
        priorityFilter: ['Low', 'Lowest'],
      });
      expect(result).toBe(false);
    });

    it('should match all priorities when filter is empty', () => {
      const result = matchesFilters(baseIssue, emptyFilters);
      expect(result).toBe(true);
    });

    it('should pass when issue has no priority and filter is set', () => {
      const noPriorityIssue = { ...baseIssue, priority: undefined };
      const result = matchesFilters(noPriorityIssue, {
        ...emptyFilters,
        priorityFilter: ['High'],
      });
      // When priority is undefined, the filter check is skipped (issue passes)
      expect(result).toBe(true);
    });
  });

  // Issue type filter
  describe('issueTypeFilter', () => {
    it('should match when issue type is in filter', () => {
      const result = matchesFilters(baseIssue, {
        ...emptyFilters,
        issueTypeFilter: ['Bug', 'Story'],
      });
      expect(result).toBe(true);
    });

    it('should not match when issue type is not in filter', () => {
      const result = matchesFilters(baseIssue, {
        ...emptyFilters,
        issueTypeFilter: ['Epic', 'Story'],
      });
      expect(result).toBe(false);
    });

    it('should match all types when filter is empty', () => {
      const result = matchesFilters(baseIssue, emptyFilters);
      expect(result).toBe(true);
    });
  });

  // Combined filters
  describe('combined filters', () => {
    it('should match when all filters pass', () => {
      const result = matchesFilters(baseIssue, {
        projectFilter: ['PROJ'],
        priorityFilter: ['High'],
        issueTypeFilter: ['Bug'],
      });
      expect(result).toBe(true);
    });

    it('should not match when any filter fails', () => {
      // Project matches, priority matches, but type doesn't
      const result = matchesFilters(baseIssue, {
        projectFilter: ['PROJ'],
        priorityFilter: ['High'],
        issueTypeFilter: ['Epic'],
      });
      expect(result).toBe(false);
    });

    it('should short-circuit on first failing filter', () => {
      // Project fails - shouldn't need to check priority or type
      const result = matchesFilters(baseIssue, {
        projectFilter: ['OTHER'],
        priorityFilter: ['High'],
        issueTypeFilter: ['Bug'],
      });
      expect(result).toBe(false);
    });
  });
});
