/**
 * Tests for HookBlockedError
 *
 * Tests the custom error class used when agent hooks block tool execution.
 */

import { describe, it, expect } from 'vitest';
import { HookBlockedError, AgentFrontmatterSchema } from './types';

describe('HookBlockedError', () => {
  describe('constructor', () => {
    it('should create error with formatted message when reason is provided', () => {
      const error = new HookBlockedError('edit_file', 'File is read-only');

      expect(error.message).toBe('Hook blocked execution of edit_file: File is read-only');
    });

    it('should create error with default message when no reason is provided', () => {
      const error = new HookBlockedError('shell_execute');

      expect(error.message).toBe('Hook blocked execution of shell_execute: No reason provided');
    });

    it('should create error with default message when reason is undefined', () => {
      const error = new HookBlockedError('git_push', undefined);

      expect(error.message).toBe('Hook blocked execution of git_push: No reason provided');
    });
  });

  describe('toolName property', () => {
    it('should correctly assign toolName property', () => {
      const error = new HookBlockedError('file_read', 'Blocked by policy');

      expect(error.toolName).toBe('file_read');
    });

    it('should correctly assign toolName when no reason is provided', () => {
      const error = new HookBlockedError('grep_search');

      expect(error.toolName).toBe('grep_search');
    });

    it('should handle special characters in tool names', () => {
      const toolName = 'mcp__github__create_pull_request';
      const error = new HookBlockedError(toolName, 'PR creation disabled');

      expect(error.toolName).toBe(toolName);
    });
  });

  describe('name property', () => {
    it('should have name property set to HookBlockedError', () => {
      const error = new HookBlockedError('some_tool');

      expect(error.name).toBe('HookBlockedError');
    });
  });

  describe('inheritance', () => {
    it('should be an instance of Error', () => {
      const error = new HookBlockedError('bash_execute', 'Not allowed');

      expect(error).toBeInstanceOf(Error);
    });

    it('should be an instance of HookBlockedError', () => {
      const error = new HookBlockedError('bash_execute', 'Not allowed');

      expect(error).toBeInstanceOf(HookBlockedError);
    });

    it('should be catchable as Error', () => {
      let caught: Error | null = null;

      try {
        throw new HookBlockedError('shell_execute', 'Blocked');
      } catch (e) {
        caught = e as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toBeInstanceOf(HookBlockedError);
    });
  });

  describe('edge cases', () => {
    it('should handle empty string as tool name', () => {
      const error = new HookBlockedError('', 'Empty tool name');

      expect(error.message).toBe('Hook blocked execution of : Empty tool name');
      expect(error.toolName).toBe('');
    });

    it('should handle empty string as reason', () => {
      const error = new HookBlockedError('some_tool', '');

      // Empty string is falsy, so it uses the default message
      expect(error.message).toBe('Hook blocked execution of some_tool: No reason provided');
    });

    it('should handle long reason strings', () => {
      const longReason = 'A'.repeat(1000);
      const error = new HookBlockedError('tool', longReason);

      expect(error.message).toBe(`Hook blocked execution of tool: ${longReason}`);
      expect(error.message.length).toBe(1000 + 'Hook blocked execution of tool: '.length);
    });
  });
});

describe('AgentFrontmatterSchema', () => {
  describe('skills property', () => {
    it('should accept valid skills array', () => {
      const frontmatter = {
        description: 'Test agent',
        skills: ['commit', 'review-pr', 'deploy'],
      };

      const result = AgentFrontmatterSchema.parse(frontmatter);

      expect(result.skills).toEqual(['commit', 'review-pr', 'deploy']);
    });

    it('should accept empty skills array', () => {
      const frontmatter = {
        description: 'Test agent',
        skills: [],
      };

      const result = AgentFrontmatterSchema.parse(frontmatter);

      expect(result.skills).toEqual([]);
    });

    it('should accept frontmatter without skills property', () => {
      const frontmatter = {
        description: 'Test agent',
      };

      const result = AgentFrontmatterSchema.parse(frontmatter);

      expect(result.skills).toBeUndefined();
    });

    it('should reject skills with non-string items', () => {
      const frontmatter = {
        description: 'Test agent',
        skills: ['valid', 123, 'also-valid'],
      };

      expect(() => AgentFrontmatterSchema.parse(frontmatter)).toThrow();
    });

    it('should work alongside other properties', () => {
      const frontmatter = {
        description: 'Security agent',
        model: 'haiku',
        'allowed-tools': ['file_read', 'grep_search'],
        skills: ['security-scan', 'check-deps'],
        'default-thoroughness': 'medium' as const,
      };

      const result = AgentFrontmatterSchema.parse(frontmatter);

      expect(result.description).toBe('Security agent');
      expect(result.model).toBe('haiku');
      expect(result['allowed-tools']).toEqual(['file_read', 'grep_search']);
      expect(result.skills).toEqual(['security-scan', 'check-deps']);
      expect(result['default-thoroughness']).toBe('medium');
    });
  });

  describe('retry property', () => {
    it('should accept a full retry config', () => {
      const result = AgentFrontmatterSchema.parse({
        description: 'Test agent',
        retry: { maxRetries: 3, initialDelay: 500 },
      });

      expect(result.retry).toEqual({ maxRetries: 3, initialDelay: 500 });
    });

    it('should accept retry with only maxRetries', () => {
      const result = AgentFrontmatterSchema.parse({
        description: 'Test agent',
        retry: { maxRetries: 1 },
      });

      expect(result.retry?.maxRetries).toBe(1);
      expect(result.retry?.initialDelay).toBeUndefined();
    });

    it('should accept retry with only initialDelay', () => {
      const result = AgentFrontmatterSchema.parse({
        description: 'Test agent',
        retry: { initialDelay: 2000 },
      });

      expect(result.retry?.initialDelay).toBe(2000);
      expect(result.retry?.maxRetries).toBeUndefined();
    });

    it('should accept frontmatter without retry property', () => {
      const result = AgentFrontmatterSchema.parse({ description: 'Test agent' });

      expect(result.retry).toBeUndefined();
    });

    it('should accept maxRetries of 0 (disable retries)', () => {
      const result = AgentFrontmatterSchema.parse({
        description: 'Test agent',
        retry: { maxRetries: 0 },
      });

      expect(result.retry?.maxRetries).toBe(0);
    });

    it('should reject negative maxRetries', () => {
      expect(() =>
        AgentFrontmatterSchema.parse({
          description: 'Test agent',
          retry: { maxRetries: -1 },
        })
      ).toThrow();
    });

    it('should reject zero initialDelay', () => {
      expect(() =>
        AgentFrontmatterSchema.parse({
          description: 'Test agent',
          retry: { initialDelay: 0 },
        })
      ).toThrow();
    });

    it('should reject negative initialDelay', () => {
      expect(() =>
        AgentFrontmatterSchema.parse({
          description: 'Test agent',
          retry: { initialDelay: -100 },
        })
      ).toThrow();
    });

    it('should reject non-integer maxRetries', () => {
      expect(() =>
        AgentFrontmatterSchema.parse({
          description: 'Test agent',
          retry: { maxRetries: 1.5 },
        })
      ).toThrow();
    });
  });
});
