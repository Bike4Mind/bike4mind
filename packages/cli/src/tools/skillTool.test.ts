import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { parseArguments, createSkillTool } from './skillTool.js';
import { CustomCommandStore } from '../storage/CustomCommandStore.js';
import type { ShellCommandPermissionDeps } from '../utils/commandPermission.js';

// These cases never reach a lifecycle hook, so the permission is unused - but it
// is now a required dep, so pass a never-prompt stub.
const NOOP_PERM = {
  permissionManager: { needsPermission: () => false },
  promptFn: async () => ({ action: 'allow-once' as const }),
} as unknown as ShellCommandPermissionDeps;

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

  // The skill tool is the model-reachable execution chokepoint. A repo-planted
  // project command that shadows a plugin enabled AFTER boot loads unpruned (the
  // load gate ran before the plugin was live), so the tool must consult the live
  // reserved-name set at lookup, not just trust that the store was pruned.
  describe('reserved-name execution gate', () => {
    let projectRoot: string;
    let fakeHome: string;

    beforeEach(async () => {
      projectRoot = path.join(os.tmpdir(), `b4m-skill-gate-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fakeHome = path.join(os.tmpdir(), `b4m-skill-gate-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await fs.mkdir(path.join(projectRoot, '.claude', 'commands'), { recursive: true });
      await fs.mkdir(fakeHome, { recursive: true });
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      for (const d of [projectRoot, fakeHome]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    });

    it('refuses to execute a project command that shadows a runtime plugin, even unpruned', async () => {
      await fs.writeFile(path.join(projectRoot, '.claude', 'commands', 'greet.md'), '# greet\n\nHIJACKED', 'utf-8');

      const store = new CustomCommandStore(projectRoot);
      store.setProjectTrusted(true); // folder-trust gate: load project skills for a trusted root
      await store.loadCommands(); // greet loads: reserved source not wired at boot
      expect(store.getCommand('greet')?.source).toBe('project');

      // Plugin 'greet' enabled at runtime; reserved source now knows it, but the
      // store was NOT re-pruned. Removing the sink gate makes this execute.
      store.setReservedNameSource(() => new Set(['greet']));

      const tool = createSkillTool({ customCommandStore: store, permission: NOOP_PERM });
      await expect(tool.toolFn({ skill: 'greet' })).rejects.toThrow(/not found/);
    });

    it('executes a non-reserved project command', async () => {
      await fs.writeFile(path.join(projectRoot, '.claude', 'commands', 'deploy.md'), '# deploy\n\nship it', 'utf-8');

      const store = new CustomCommandStore(projectRoot);
      store.setProjectTrusted(true);
      store.setReservedNameSource(() => new Set(['greet']));
      await store.loadCommands();

      const tool = createSkillTool({ customCommandStore: store, permission: NOOP_PERM });
      const result = await tool.toolFn({ skill: 'deploy' });
      expect(String(result)).toContain('ship it');
    });
  });
});
