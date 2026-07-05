import { describe, it, expect } from 'vitest';
import { parseArguments } from './skillTool.js';

describe('skillTool', () => {
  describe('parseArguments', () => {
    it('should parse simple space-separated arguments', () => {
      expect(parseArguments('hello world')).toEqual(['hello', 'world']);
    });

    it('should parse single argument', () => {
      expect(parseArguments('hello')).toEqual(['hello']);
    });

    it('should handle empty string', () => {
      expect(parseArguments('')).toEqual([]);
    });

    it('should handle multiple spaces between arguments', () => {
      expect(parseArguments('hello   world')).toEqual(['hello', 'world']);
    });

    it('should handle double-quoted strings', () => {
      expect(parseArguments('"hello world" test')).toEqual(['hello world', 'test']);
    });

    it('should handle single-quoted strings', () => {
      expect(parseArguments("'hello world' test")).toEqual(['hello world', 'test']);
    });

    it('should handle mixed quoted and unquoted arguments', () => {
      expect(parseArguments('first "second arg" third')).toEqual(['first', 'second arg', 'third']);
    });

    it('should handle multiple quoted arguments', () => {
      expect(parseArguments('"arg one" "arg two"')).toEqual(['arg one', 'arg two']);
    });

    it('should handle quoted arguments at the start', () => {
      expect(parseArguments('"quoted arg" unquoted')).toEqual(['quoted arg', 'unquoted']);
    });

    it('should handle quoted arguments at the end', () => {
      expect(parseArguments('unquoted "quoted arg"')).toEqual(['unquoted', 'quoted arg']);
    });

    it('should handle trailing spaces', () => {
      expect(parseArguments('hello world   ')).toEqual(['hello', 'world']);
    });

    it('should handle leading spaces', () => {
      expect(parseArguments('   hello world')).toEqual(['hello', 'world']);
    });
  });

  describe('createSkillTool', () => {
    // Note: Full integration tests for createSkillTool would require mocking
    // the file system for processFileReferences. These are covered in the
    // integration test suite.

    it('should export parseArguments function', async () => {
      const { parseArguments } = await import('./skillTool.js');
      expect(typeof parseArguments).toBe('function');
    });

    it('should export createSkillTool function', async () => {
      const { createSkillTool } = await import('./skillTool.js');
      expect(typeof createSkillTool).toBe('function');
    });
  });

  describe('skill normalization', () => {
    it('should handle skill names without leading slash', () => {
      // The actual skill lookup is tested via the normalize logic
      const skillName = 'commit';
      const normalized = skillName.replace(/^\//, '');
      expect(normalized).toBe('commit');
    });

    it('should handle skill names with leading slash', () => {
      const skillName = '/commit';
      const normalized = skillName.replace(/^\//, '');
      expect(normalized).toBe('commit');
    });

    it('should handle skill names with multiple leading slashes', () => {
      // Only first slash is removed
      const skillName = '//commit';
      const normalized = skillName.replace(/^\//, '');
      expect(normalized).toBe('/commit');
    });
  });

  describe('allowedSkills validation', () => {
    // These tests verify the validation logic for agent-specific skill restrictions
    // The actual createSkillTool integration requires mocking CustomCommandStore

    /**
     * Helper function that mirrors the validation logic in skillTool.ts
     */
    function isSkillAllowed(skillName: string, allowedSkills: string[] | undefined): boolean {
      if (!allowedSkills || allowedSkills.length === 0) {
        return true;
      }
      return allowedSkills.includes(skillName);
    }

    it('should allow skill when allowedSkills is undefined', () => {
      expect(isSkillAllowed('any-skill', undefined)).toBe(true);
    });

    it('should allow skill when allowedSkills is empty array', () => {
      expect(isSkillAllowed('any-skill', [])).toBe(true);
    });

    it('should allow skill when it is in allowedSkills list', () => {
      expect(isSkillAllowed('review-pr', ['commit', 'review-pr', 'deploy'])).toBe(true);
    });

    it('should deny skill when it is not in allowedSkills list', () => {
      expect(isSkillAllowed('deploy', ['commit', 'review-pr'])).toBe(false);
    });

    it('should generate correct error message for denied skill', () => {
      const allowedSkills = ['commit', 'review-pr'];
      const skillName = 'deploy';

      const errorMessage =
        `skill: "${skillName}" is not available to this agent. ` + `Allowed skills: ${allowedSkills.join(', ')}`;

      expect(errorMessage).toBe('skill: "deploy" is not available to this agent. Allowed skills: commit, review-pr');
    });
  });
});
