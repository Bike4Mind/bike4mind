import { describe, it, expect } from 'vitest';
import {
  ownerSchema,
  repoSchema,
  orgSchema,
  issueNumberSchema,
  issueStateSchema,
  prStateSchema,
  projectIdSchema,
  issueNodeIdSchema,
  projectItemIdSchema,
  confirmationParams,
  paginationParams,
} from '../../helpers/schemas.js';

describe('Schema Validations', () => {
  describe('ownerSchema', () => {
    it('should accept valid owner names', () => {
      const validOwners = ['octocat', 'github', 'user123', 'my-org', 'a1b2c3'];
      validOwners.forEach(owner => {
        expect(() => ownerSchema.parse(owner)).not.toThrow();
      });
    });

    it('should reject empty string', () => {
      expect(() => ownerSchema.parse('')).toThrow();
    });

    it('should reject names starting with hyphen', () => {
      expect(() => ownerSchema.parse('-invalid')).toThrow();
    });

    it('should reject names ending with hyphen', () => {
      expect(() => ownerSchema.parse('invalid-')).toThrow();
    });

    it('should reject names with special characters', () => {
      const invalid = ['user@name', 'user/name', 'user.name', 'user_name'];
      invalid.forEach(name => {
        expect(() => ownerSchema.parse(name)).toThrow();
      });
    });

    it('should accept single character names', () => {
      expect(() => ownerSchema.parse('a')).not.toThrow();
    });
  });

  describe('repoSchema', () => {
    it('should accept valid repository names', () => {
      const validRepos = ['repo', 'my-repo', 'repo.js', 'repo_name', 'repo-name.test'];
      validRepos.forEach(repo => {
        expect(() => repoSchema.parse(repo)).not.toThrow();
      });
    });

    it('should reject empty string', () => {
      expect(() => repoSchema.parse('')).toThrow();
    });

    it('should reject names with special characters', () => {
      const invalid = ['repo/name', 'repo@name', 'repo name', 'repo!name'];
      invalid.forEach(name => {
        expect(() => repoSchema.parse(name)).toThrow();
      });
    });
  });

  describe('orgSchema', () => {
    it('should accept valid organization names', () => {
      expect(() => orgSchema.parse('github')).not.toThrow();
      expect(() => orgSchema.parse('my-org')).not.toThrow();
    });

    it('should reject empty string', () => {
      expect(() => orgSchema.parse('')).toThrow();
    });

    it('should have same validation as ownerSchema', () => {
      // Both should reject hyphen at start/end
      expect(() => orgSchema.parse('-org')).toThrow();
      expect(() => orgSchema.parse('org-')).toThrow();
    });
  });

  describe('issueNumberSchema', () => {
    it('should accept positive integers', () => {
      expect(issueNumberSchema.parse(1)).toBe(1);
      expect(issueNumberSchema.parse(100)).toBe(100);
      expect(issueNumberSchema.parse(999999)).toBe(999999);
    });

    it('should reject zero', () => {
      expect(() => issueNumberSchema.parse(0)).toThrow();
    });

    it('should reject negative numbers', () => {
      expect(() => issueNumberSchema.parse(-1)).toThrow();
    });
  });

  describe('issueStateSchema', () => {
    it('should accept valid states', () => {
      expect(issueStateSchema.parse('open')).toBe('open');
      expect(issueStateSchema.parse('closed')).toBe('closed');
      expect(issueStateSchema.parse('all')).toBe('all');
    });

    it('should accept undefined (optional)', () => {
      expect(issueStateSchema.parse(undefined)).toBeUndefined();
    });

    it('should reject invalid states', () => {
      expect(() => issueStateSchema.parse('pending')).toThrow();
      expect(() => issueStateSchema.parse('draft')).toThrow();
    });
  });

  describe('prStateSchema', () => {
    it('should accept valid PR states', () => {
      expect(prStateSchema.parse('open')).toBe('open');
      expect(prStateSchema.parse('closed')).toBe('closed');
      expect(prStateSchema.parse('all')).toBe('all');
    });

    it('should accept undefined (optional)', () => {
      expect(prStateSchema.parse(undefined)).toBeUndefined();
    });
  });

  describe('projectIdSchema', () => {
    it('should accept valid project IDs starting with PVT_', () => {
      expect(projectIdSchema.parse('PVT_kwDOABC123')).toBe('PVT_kwDOABC123');
      expect(projectIdSchema.parse('PVT_abc')).toBe('PVT_abc');
    });

    it('should reject IDs not starting with PVT_', () => {
      expect(() => projectIdSchema.parse('PVTI_abc')).toThrow();
      expect(() => projectIdSchema.parse('I_abc')).toThrow();
      expect(() => projectIdSchema.parse('abc')).toThrow();
    });
  });

  describe('issueNodeIdSchema', () => {
    it('should accept valid issue node IDs starting with I_', () => {
      expect(issueNodeIdSchema.parse('I_kwDOABC123')).toBe('I_kwDOABC123');
      expect(issueNodeIdSchema.parse('I_abc')).toBe('I_abc');
    });

    it('should reject IDs not starting with I_', () => {
      expect(() => issueNodeIdSchema.parse('PVT_abc')).toThrow();
      expect(() => issueNodeIdSchema.parse('PVTI_abc')).toThrow();
      expect(() => issueNodeIdSchema.parse('123')).toThrow();
    });
  });

  describe('projectItemIdSchema', () => {
    it('should accept valid project item IDs starting with PVTI_', () => {
      expect(projectItemIdSchema.parse('PVTI_kwDOABC123')).toBe('PVTI_kwDOABC123');
      expect(projectItemIdSchema.parse('PVTI_abc')).toBe('PVTI_abc');
    });

    it('should reject IDs not starting with PVTI_', () => {
      expect(() => projectItemIdSchema.parse('PVT_abc')).toThrow();
      expect(() => projectItemIdSchema.parse('I_abc')).toThrow();
    });
  });

  describe('confirmationParams', () => {
    it('should have confirmed field defaulting to false', () => {
      expect(confirmationParams.confirmed.parse(undefined)).toBe(false);
      expect(confirmationParams.confirmed.parse(true)).toBe(true);
      expect(confirmationParams.confirmed.parse(false)).toBe(false);
    });

    it('should have optional _executeFromButton field', () => {
      expect(confirmationParams._executeFromButton.parse(undefined)).toBeUndefined();
      expect(confirmationParams._executeFromButton.parse(true)).toBe(true);
      expect(confirmationParams._executeFromButton.parse(false)).toBe(false);
    });
  });

  describe('paginationParams', () => {
    it('should have optional per_page field', () => {
      expect(paginationParams.per_page.parse(undefined)).toBeUndefined();
      expect(paginationParams.per_page.parse(30)).toBe(30);
      expect(paginationParams.per_page.parse(100)).toBe(100);
    });

    it('should have optional page field', () => {
      expect(paginationParams.page.parse(undefined)).toBeUndefined();
      expect(paginationParams.page.parse(1)).toBe(1);
      expect(paginationParams.page.parse(10)).toBe(10);
    });
  });
});
