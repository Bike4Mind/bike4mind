/**
 * Tests for PermissionManager
 *
 * Tests the security-critical permission system that controls
 * which tools can execute without user approval.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PermissionManager } from './PermissionManager';
import type { ToolCategory } from '../config/toolSafety';

describe('PermissionManager', () => {
  describe('constructor', () => {
    it('should initialize with empty trusted tools by default', () => {
      const manager = new PermissionManager();
      expect(manager.getTrustedTools()).toEqual([]);
    });

    it('should initialize with provided trusted tools', () => {
      const manager = new PermissionManager(['file_read', 'grep_search']);
      expect(manager.getTrustedTools()).toEqual(['file_read', 'grep_search']);
    });

    it('should initialize with custom tool categories', () => {
      const customCategories: Record<string, ToolCategory> = {
        custom_tool: 'auto_approve',
      };
      const manager = new PermissionManager([], customCategories);
      expect(manager.getCategory('custom_tool')).toBe('auto_approve');
    });

    it('should initialize with denied tools from project config', () => {
      const manager = new PermissionManager([], {}, ['shell_execute']);
      expect(manager.isDenied('shell_execute')).toBe(true);
      expect(manager.getDeniedTools()).toEqual(['shell_execute']);
    });
  });

  describe('needsPermission', () => {
    it('should return false for auto_approve tools', () => {
      const manager = new PermissionManager();
      expect(manager.needsPermission('math_evaluate')).toBe(false);
      expect(manager.needsPermission('current_datetime')).toBe(false);
    });

    it('should return true for prompt_always tools', () => {
      const manager = new PermissionManager();
      expect(manager.needsPermission('edit_file')).toBe(true);
      expect(manager.needsPermission('shell_execute')).toBe(true);
      expect(manager.needsPermission('git_commit')).toBe(true);
    });

    it('should return true for prompt_default tools that are not trusted', () => {
      const manager = new PermissionManager();
      expect(manager.needsPermission('file_read')).toBe(true);
      expect(manager.needsPermission('grep_search')).toBe(true);
    });

    it('should return false for prompt_default tools that are trusted', () => {
      const manager = new PermissionManager(['file_read', 'grep_search']);
      expect(manager.needsPermission('file_read')).toBe(false);
      expect(manager.needsPermission('grep_search')).toBe(false);
    });

    it('should return true for unknown tools', () => {
      const manager = new PermissionManager();
      expect(manager.needsPermission('unknown_tool')).toBe(true);
    });

    it('should always return true for denied tools, even if trusted', () => {
      const manager = new PermissionManager(['bash_execute'], {}, ['bash_execute']);
      // Even though bash_execute is in trusted list, it's denied by project config
      expect(manager.needsPermission('bash_execute')).toBe(true);
    });

    it('should respect custom tool categories', () => {
      const manager = new PermissionManager([], { custom_safe_tool: 'auto_approve' });
      expect(manager.needsPermission('custom_safe_tool')).toBe(false);
    });
  });

  describe('trustTool', () => {
    let manager: PermissionManager;

    beforeEach(() => {
      manager = new PermissionManager();
    });

    it('should add prompt_default tool to trusted list', () => {
      const result = manager.trustTool('file_read');
      expect(result).toBe(true);
      expect(manager.isTrusted('file_read')).toBe(true);
      expect(manager.needsPermission('file_read')).toBe(false);
    });

    it('should return false when trying to trust prompt_always tool', () => {
      const result = manager.trustTool('edit_file');
      expect(result).toBe(false);
      expect(manager.isTrusted('edit_file')).toBe(false);
      expect(manager.needsPermission('edit_file')).toBe(true);
    });

    it('should allow trusting auto_approve tools (no-op since already approved)', () => {
      const result = manager.trustTool('math_evaluate');
      expect(result).toBe(true);
      expect(manager.isTrusted('math_evaluate')).toBe(true);
    });

    it('should return false when trying to trust denied tool', () => {
      const manager = new PermissionManager([], {}, ['file_read']);
      const result = manager.trustTool('file_read');
      expect(result).toBe(false);
      expect(manager.isTrusted('file_read')).toBe(false);
    });

    it('should handle multiple tools', () => {
      manager.trustTool('file_read');
      manager.trustTool('grep_search');
      manager.trustTool('git_status');

      expect(manager.getTrustedTools()).toEqual(['file_read', 'git_status', 'grep_search']);
    });

    it('should not duplicate tools in trusted list', () => {
      manager.trustTool('file_read');
      manager.trustTool('file_read');
      manager.trustTool('file_read');

      expect(manager.getTrustedTools()).toEqual(['file_read']);
    });
  });

  describe('untrustTool', () => {
    it('should remove tool from trusted list', () => {
      const manager = new PermissionManager(['file_read', 'grep_search']);
      manager.untrustTool('file_read');

      expect(manager.isTrusted('file_read')).toBe(false);
      expect(manager.isTrusted('grep_search')).toBe(true);
      expect(manager.getTrustedTools()).toEqual(['grep_search']);
    });

    it('should be idempotent (safe to call multiple times)', () => {
      const manager = new PermissionManager(['file_read']);
      manager.untrustTool('file_read');
      manager.untrustTool('file_read');

      expect(manager.getTrustedTools()).toEqual([]);
    });

    it('should handle untrusting non-existent tool gracefully', () => {
      const manager = new PermissionManager();
      manager.untrustTool('file_read');

      expect(manager.getTrustedTools()).toEqual([]);
    });
  });

  describe('getTrustedTools', () => {
    it('should return empty array when no tools trusted', () => {
      const manager = new PermissionManager();
      expect(manager.getTrustedTools()).toEqual([]);
    });

    it('should return sorted list of trusted tools', () => {
      const manager = new PermissionManager(['zebra_tool', 'alpha_tool', 'middle_tool']);
      expect(manager.getTrustedTools()).toEqual(['alpha_tool', 'middle_tool', 'zebra_tool']);
    });
  });

  describe('isTrusted', () => {
    it('should return true for trusted tools', () => {
      const manager = new PermissionManager(['file_read']);
      expect(manager.isTrusted('file_read')).toBe(true);
    });

    it('should return false for non-trusted tools', () => {
      const manager = new PermissionManager(['file_read']);
      expect(manager.isTrusted('grep_search')).toBe(false);
    });

    it('should return false for empty manager', () => {
      const manager = new PermissionManager();
      expect(manager.isTrusted('file_read')).toBe(false);
    });
  });

  describe('getCategory', () => {
    it('should return correct category for default tools', () => {
      const manager = new PermissionManager();
      expect(manager.getCategory('math_evaluate')).toBe('auto_approve');
      expect(manager.getCategory('edit_file')).toBe('prompt_always');
      expect(manager.getCategory('file_read')).toBe('prompt_default');
    });

    it('should return prompt_default for unknown tools', () => {
      const manager = new PermissionManager();
      expect(manager.getCategory('unknown_tool')).toBe('prompt_default');
    });

    it('should respect custom categories', () => {
      const manager = new PermissionManager([], {
        custom_tool: 'auto_approve',
      });
      expect(manager.getCategory('custom_tool')).toBe('auto_approve');
    });

    it('should prioritize custom categories over default', () => {
      const manager = new PermissionManager([], {
        file_read: 'auto_approve', // Override default
      });
      expect(manager.getCategory('file_read')).toBe('auto_approve');
    });
  });

  describe('canBeTrusted', () => {
    it('should return true for auto_approve tools', () => {
      const manager = new PermissionManager();
      expect(manager.canBeTrusted('math_evaluate')).toBe(true);
    });

    it('should return false for prompt_always tools', () => {
      const manager = new PermissionManager();
      expect(manager.canBeTrusted('edit_file')).toBe(false);
      expect(manager.canBeTrusted('shell_execute')).toBe(false);
    });

    it('should return true for prompt_default tools', () => {
      const manager = new PermissionManager();
      expect(manager.canBeTrusted('file_read')).toBe(true);
      expect(manager.canBeTrusted('grep_search')).toBe(true);
    });

    it('should return false for denied tools', () => {
      const manager = new PermissionManager([], {}, ['file_read']);
      expect(manager.canBeTrusted('file_read')).toBe(false);
    });
  });

  describe('isDenied and getDeniedTools', () => {
    it('should identify denied tools', () => {
      const manager = new PermissionManager([], {}, ['bash_execute', 'git_push']);
      expect(manager.isDenied('bash_execute')).toBe(true);
      expect(manager.isDenied('git_push')).toBe(true);
      expect(manager.isDenied('file_read')).toBe(false);
    });

    it('should return sorted list of denied tools', () => {
      const manager = new PermissionManager([], {}, ['zebra', 'alpha', 'middle']);
      expect(manager.getDeniedTools()).toEqual(['alpha', 'middle', 'zebra']);
    });

    it('should return empty array when no tools denied', () => {
      const manager = new PermissionManager();
      expect(manager.getDeniedTools()).toEqual([]);
    });
  });

  describe('clearTrustedTools', () => {
    it('should remove all trusted tools', () => {
      const manager = new PermissionManager(['file_read', 'grep_search', 'git_status']);
      manager.clearTrustedTools();

      expect(manager.getTrustedTools()).toEqual([]);
      expect(manager.isTrusted('file_read')).toBe(false);
      expect(manager.isTrusted('grep_search')).toBe(false);
    });

    it('should be idempotent', () => {
      const manager = new PermissionManager(['file_read']);
      manager.clearTrustedTools();
      manager.clearTrustedTools();

      expect(manager.getTrustedTools()).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return correct trusted count', () => {
      const manager = new PermissionManager(['file_read', 'grep_search']);
      const stats = manager.getStats();
      expect(stats.trustedCount).toBe(2);
    });

    it('should return zero for empty manager', () => {
      const manager = new PermissionManager();
      const stats = manager.getStats();
      expect(stats.trustedCount).toBe(0);
    });
  });

  describe('trustToolForSession', () => {
    let manager: PermissionManager;

    beforeEach(() => {
      manager = new PermissionManager();
    });

    it('should trust prompt_default tools for session', () => {
      manager.trustToolForSession('file_read');
      expect(manager.isSessionTrusted('file_read')).toBe(true);
      expect(manager.needsPermission('file_read')).toBe(false);
    });

    it('should trust prompt_always tools for session', () => {
      manager.trustToolForSession('edit_file');
      expect(manager.isSessionTrusted('edit_file')).toBe(true);
      expect(manager.needsPermission('edit_file')).toBe(false);
    });

    it('should not trust project-denied tools for session', () => {
      const mgr = new PermissionManager([], {}, ['bash_execute']);
      const result = mgr.trustToolForSession('bash_execute');
      expect(result).toBe(false);
      expect(mgr.isSessionTrusted('bash_execute')).toBe(false);
      expect(mgr.needsPermission('bash_execute')).toBe(true);
    });

    it('should not affect permanent trust', () => {
      manager.trustToolForSession('file_read');
      expect(manager.isTrusted('file_read')).toBe(false);
      expect(manager.isSessionTrusted('file_read')).toBe(true);
    });

    it('should not duplicate tools in session trusted list', () => {
      manager.trustToolForSession('edit_file');
      manager.trustToolForSession('edit_file');
      expect(manager.isSessionTrusted('edit_file')).toBe(true);
    });
  });

  describe('isSessionTrusted', () => {
    it('should return false for tools not session-trusted', () => {
      const manager = new PermissionManager();
      expect(manager.isSessionTrusted('file_read')).toBe(false);
    });

    it('should return false for permanently trusted tools', () => {
      const manager = new PermissionManager(['file_read']);
      expect(manager.isSessionTrusted('file_read')).toBe(false);
    });
  });

  describe('clearSessionTrust', () => {
    it('should clear all session-trusted tools', () => {
      const manager = new PermissionManager();
      manager.trustToolForSession('edit_file');
      manager.trustToolForSession('bash_execute');
      manager.clearSessionTrust();

      expect(manager.isSessionTrusted('edit_file')).toBe(false);
      expect(manager.isSessionTrusted('bash_execute')).toBe(false);
      expect(manager.needsPermission('edit_file')).toBe(true);
    });

    it('should not affect permanent trust', () => {
      const manager = new PermissionManager(['file_read']);
      manager.trustToolForSession('edit_file');
      manager.clearSessionTrust();

      expect(manager.isTrusted('file_read')).toBe(true);
      expect(manager.needsPermission('file_read')).toBe(false);
    });

    it('should be idempotent', () => {
      const manager = new PermissionManager();
      manager.trustToolForSession('edit_file');
      manager.clearSessionTrust();
      manager.clearSessionTrust();
      expect(manager.isSessionTrusted('edit_file')).toBe(false);
    });
  });

  describe('security edge cases', () => {
    it('should prevent trusting dangerous tools via custom categories', () => {
      // Attempt to override prompt_always tool to auto_approve (should not work)
      const manager = new PermissionManager([], {
        edit_file: 'prompt_always', // Keep it dangerous
      });

      const result = manager.trustTool('edit_file');
      expect(result).toBe(false);
      expect(manager.needsPermission('edit_file')).toBe(true);
    });

    it('should respect project denied tools over local trusted tools', () => {
      // Project denies bash_execute, but user tries to trust it locally
      const manager = new PermissionManager(['bash_execute'], {}, ['bash_execute']);

      // Tool is in trusted list but denied by project
      expect(manager.isTrusted('bash_execute')).toBe(true); // Locally trusted
      expect(manager.isDenied('bash_execute')).toBe(true); // But project denied
      expect(manager.needsPermission('bash_execute')).toBe(true); // Must ask permission
      expect(manager.canBeTrusted('bash_execute')).toBe(false); // Cannot be trusted
    });

    it('should handle empty string tool names', () => {
      const manager = new PermissionManager();
      expect(manager.needsPermission('')).toBe(true);
      expect(manager.getCategory('')).toBe('prompt_default');
    });

    it('should handle special characters in tool names', () => {
      const manager = new PermissionManager();
      const specialTools = ['tool-with-dash', 'tool_with_underscore', 'tool.with.dots', 'tool$with$dollars'];

      specialTools.forEach(tool => {
        expect(manager.needsPermission(tool)).toBe(true);
        expect(manager.trustTool(tool)).toBe(true);
        expect(manager.isTrusted(tool)).toBe(true);
      });
    });

    it('should maintain immutability of trusted tools list', () => {
      const manager = new PermissionManager(['file_read']);
      const trustedList1 = manager.getTrustedTools();
      trustedList1.push('grep_search'); // Try to mutate

      const trustedList2 = manager.getTrustedTools();
      expect(trustedList2).toEqual(['file_read']); // Should not include mutated item
    });

    it('should handle concurrent trust/untrust operations', () => {
      const manager = new PermissionManager();

      manager.trustTool('file_read');
      manager.trustTool('grep_search');
      manager.untrustTool('file_read');
      manager.trustTool('git_status');
      manager.untrustTool('grep_search');

      expect(manager.getTrustedTools()).toEqual(['git_status']);
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical development workflow', () => {
      // Start with no trusted tools
      const manager = new PermissionManager();

      // User approves file_read for first time
      expect(manager.needsPermission('file_read')).toBe(true);

      // User decides to trust it
      manager.trustTool('file_read');
      expect(manager.needsPermission('file_read')).toBe(false);

      // User tries to edit file - should always need permission
      expect(manager.needsPermission('edit_file')).toBe(true);
      expect(manager.trustTool('edit_file')).toBe(false); // Cannot trust

      // User trusts more read-only tools
      manager.trustTool('grep_search');
      manager.trustTool('git_status');

      expect(manager.getTrustedTools()).toEqual(['file_read', 'git_status', 'grep_search']);
    });

    it('should handle project config restrictions', () => {
      // Project config denies certain tools
      const deniedTools = ['bash_execute', 'shell_execute'];
      const manager = new PermissionManager([], {}, deniedTools);

      // These tools always need permission, cannot be trusted
      deniedTools.forEach(tool => {
        expect(manager.needsPermission(tool)).toBe(true);
        expect(manager.canBeTrusted(tool)).toBe(false);
        expect(manager.trustTool(tool)).toBe(false);
      });

      // Other tools can still be trusted
      expect(manager.trustTool('file_read')).toBe(true);
      expect(manager.needsPermission('file_read')).toBe(false);
    });

    it('should handle user revoking trust', () => {
      const manager = new PermissionManager(['file_read', 'grep_search']);

      // Initially trusted
      expect(manager.needsPermission('file_read')).toBe(false);

      // User revokes trust
      manager.untrustTool('file_read');

      // Now needs permission again
      expect(manager.needsPermission('file_read')).toBe(true);
      expect(manager.isTrusted('file_read')).toBe(false);

      // Other tools still trusted
      expect(manager.isTrusted('grep_search')).toBe(true);
    });

    it('should handle session trust workflow for dangerous tools', () => {
      const manager = new PermissionManager();

      // edit_file always needs permission (prompt_always)
      expect(manager.needsPermission('edit_file')).toBe(true);
      expect(manager.trustTool('edit_file')).toBe(false); // Cannot permanently trust

      // User trusts for session
      manager.trustToolForSession('edit_file');
      expect(manager.needsPermission('edit_file')).toBe(false); // Now auto-approved

      // Session ends (clear session trust)
      manager.clearSessionTrust();
      expect(manager.needsPermission('edit_file')).toBe(true); // Prompts again
    });

    it('should handle coexistence of session and permanent trust', () => {
      const manager = new PermissionManager(['file_read']);

      // file_read permanently trusted, edit_file session-trusted
      manager.trustToolForSession('edit_file');

      expect(manager.needsPermission('file_read')).toBe(false);
      expect(manager.needsPermission('edit_file')).toBe(false);

      // Clear session trust - permanent trust unaffected
      manager.clearSessionTrust();
      expect(manager.needsPermission('file_read')).toBe(false);
      expect(manager.needsPermission('edit_file')).toBe(true);
    });
  });
});
