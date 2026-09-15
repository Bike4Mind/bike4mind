import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  loadContextFiles,
  extractCompactInstructions,
  CONTEXT_FILE_SIZE_LIMIT,
  PROJECT_CONTEXT_FILES,
  GLOBAL_CONTEXT_FILES,
} from './contextLoader.js';

// Mock the fs module
vi.mock('node:fs');
vi.mock('node:os');

// Helper to create ENOENT error
function createEnoentError(): NodeJS.ErrnoException {
  const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

// Helper to create EACCES error
function createEaccesError(): NodeJS.ErrnoException {
  const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}

describe('contextLoader', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue('/home/user/project');
    vi.mocked(os.homedir).mockReturnValue('/home/user');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constants', () => {
    it('should have correct size limit (100KB)', () => {
      expect(CONTEXT_FILE_SIZE_LIMIT).toBe(100 * 1024);
    });

    it('should have project context files in priority order', () => {
      expect(PROJECT_CONTEXT_FILES).toEqual([
        'CLAUDE.local.md',
        'CLAUDE.md',
        'AGENTS.md',
        'AI.local.md',
        'AI.md',
        'INSTRUCTIONS.md',
      ]);
    });

    it('should have global context files in priority order', () => {
      expect(GLOBAL_CONTEXT_FILES).toEqual(['AI.local.md', 'AI.md']);
    });
  });

  describe('loadContextFiles', () => {
    describe('global context loading', () => {
      it('should load AI.local.md from global directory with highest priority', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/home/user/.bike4mind/AI.local.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('global AI local content');

        const result = await loadContextFiles(null);

        expect(result.globalContext).not.toBeNull();
        expect(result.globalContext?.filename).toBe('AI.local.md');
        expect(result.globalContext?.content).toBe('global AI local content');
        expect(result.globalContext?.source).toBe('global');
      });

      it('should fall back to AI.md if AI.local.md not found', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/home/user/.bike4mind/AI.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('global AI content');

        const result = await loadContextFiles(null);

        expect(result.globalContext).not.toBeNull();
        expect(result.globalContext?.filename).toBe('AI.md');
        expect(result.globalContext?.content).toBe('global AI content');
      });

      it('should return null if no global context files found', async () => {
        vi.mocked(fs.lstatSync).mockImplementation(() => {
          throw createEnoentError();
        });

        const result = await loadContextFiles(null);

        expect(result.globalContext).toBeNull();
        expect(result.errors).toEqual([]);
      });
    });

    describe('project context loading', () => {
      it('should load CLAUDE.local.md with highest priority', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/my/project/CLAUDE.local.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('claude local content');

        const result = await loadContextFiles('/my/project');

        expect(result.projectContext).not.toBeNull();
        expect(result.projectContext?.filename).toBe('CLAUDE.local.md');
        expect(result.projectContext?.content).toBe('claude local content');
        expect(result.projectContext?.source).toBe('project');
      });

      it('should fall back to CLAUDE.md if CLAUDE.local.md not found', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/my/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('claude content');

        const result = await loadContextFiles('/my/project');

        expect(result.projectContext?.filename).toBe('CLAUDE.md');
      });

      it('should load AGENTS.md as cross-tool standard', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/my/project/AGENTS.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('agents content');

        const result = await loadContextFiles('/my/project');

        expect(result.projectContext?.filename).toBe('AGENTS.md');
      });

      it('should load INSTRUCTIONS.md as lowest priority', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/my/project/INSTRUCTIONS.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('instructions content');

        const result = await loadContextFiles('/my/project');

        expect(result.projectContext?.filename).toBe('INSTRUCTIONS.md');
      });

      it('should return null if no project context files found', async () => {
        vi.mocked(fs.lstatSync).mockImplementation(() => {
          throw createEnoentError();
        });

        const result = await loadContextFiles('/my/project');

        expect(result.projectContext).toBeNull();
        expect(result.errors).toEqual([]);
      });

      it('should use cwd when projectDir is null', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/home/user/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('cwd claude content');

        const result = await loadContextFiles(null);

        expect(result.projectContext?.path).toBe('/home/user/project/CLAUDE.md');
      });
    });

    describe('file priority order', () => {
      it('should prefer CLAUDE.local.md over CLAUDE.md', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          const pathStr = p.toString();
          if (pathStr.includes('CLAUDE.local.md') || pathStr.includes('CLAUDE.md')) {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('local content');

        const result = await loadContextFiles('/my/project');

        expect(result.projectContext?.filename).toBe('CLAUDE.local.md');
      });

      it('should prefer CLAUDE.md over AGENTS.md', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          const pathStr = p.toString();
          // CLAUDE.local.md not found, but CLAUDE.md and AGENTS.md exist
          if (pathStr.endsWith('CLAUDE.md') || pathStr.endsWith('AGENTS.md')) {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('claude content');

        const result = await loadContextFiles('/my/project');

        expect(result.projectContext?.filename).toBe('CLAUDE.md');
      });
    });

    describe('content merging', () => {
      it('should merge global and project context with separator', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          const pathStr = p.toString();
          if (pathStr === '/home/user/.bike4mind/AI.md' || pathStr === '/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
          if (p.toString().includes('AI.md')) return 'global content';
          return 'project content';
        });

        const result = await loadContextFiles('/project');

        expect(result.mergedContent).toBe('global content\n\n---\n\nproject content');
      });

      it('should return only global content when project is empty', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/home/user/.bike4mind/AI.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('global only');

        const result = await loadContextFiles('/project');

        expect(result.mergedContent).toBe('global only');
      });

      it('should return only project content when global is empty', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('project only');

        const result = await loadContextFiles('/project');

        expect(result.mergedContent).toBe('project only');
      });

      it('should return empty string when both are empty', async () => {
        vi.mocked(fs.lstatSync).mockImplementation(() => {
          throw createEnoentError();
        });

        const result = await loadContextFiles('/project');

        expect(result.mergedContent).toBe('');
      });
    });

    describe('error handling', () => {
      it('should add error for files exceeding 100KB limit', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/project/CLAUDE.md') {
            return {
              isDirectory: () => false,
              isSymbolicLink: () => false,
              size: 150 * 1024, // 150KB, exceeds 100KB limit
            } as fs.Stats;
          }
          throw createEnoentError();
        });

        const result = await loadContextFiles('/project');

        expect(result.projectContext).toBeNull();
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('exceeds 100KB limit');
        expect(result.errors[0]).toContain('150.0KB');
      });

      it('should handle ENOENT gracefully (return null, not error)', async () => {
        vi.mocked(fs.lstatSync).mockImplementation(() => {
          throw createEnoentError();
        });

        const result = await loadContextFiles('/project');

        expect(result.projectContext).toBeNull();
        expect(result.errors).toEqual([]);
      });

      it('should handle permission errors gracefully', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockImplementation(() => {
          throw createEaccesError();
        });

        const result = await loadContextFiles('/project');

        expect(result.projectContext).toBeNull();
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('permission denied');
      });

      it('should continue loading if one layer fails', async () => {
        // Global file fails with size limit, project file succeeds
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          const pathStr = p.toString();
          if (pathStr === '/home/user/.bike4mind/AI.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 150 * 1024 } as fs.Stats;
          }
          if (pathStr === '/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('project content');

        const result = await loadContextFiles('/project');

        expect(result.globalContext).toBeNull();
        expect(result.projectContext?.content).toBe('project content');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Global');
      });
    });

    describe('directory handling', () => {
      it('should skip directories', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          const pathStr = p.toString();
          if (pathStr === '/project/CLAUDE.local.md') {
            return { isDirectory: () => true, isSymbolicLink: () => false, size: 0 } as fs.Stats;
          }
          if (pathStr === '/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('file content');

        const result = await loadContextFiles('/project');

        // Should skip CLAUDE.local.md (directory) and load CLAUDE.md
        expect(result.projectContext?.filename).toBe('CLAUDE.md');
      });
    });

    describe('symlink handling', () => {
      it('should reject symlinks for security', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          if (p === '/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => true, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });

        const result = await loadContextFiles('/project');

        expect(result.projectContext).toBeNull();
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('symlink');
        expect(result.errors[0]).toContain('not allowed for security');
      });

      it('should report symlink error and stop search', async () => {
        vi.mocked(fs.lstatSync).mockImplementation((p: fs.PathLike) => {
          const pathStr = p.toString();
          if (pathStr === '/project/CLAUDE.local.md') {
            return { isDirectory: () => false, isSymbolicLink: () => true, size: 100 } as fs.Stats;
          }
          if (pathStr === '/project/CLAUDE.md') {
            return { isDirectory: () => false, isSymbolicLink: () => false, size: 100 } as fs.Stats;
          }
          throw createEnoentError();
        });
        vi.mocked(fs.readFileSync).mockReturnValue('safe content');

        const result = await loadContextFiles('/project');

        // Should report error for symlink and stop the search (security)
        expect(result.projectContext).toBeNull();
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('symlink');
      });
    });
  });

  describe('extractCompactInstructions', () => {
    it('should extract content from # Compact Instructions heading', () => {
      const content = `
# Project Setup

Some setup instructions here.

# Compact Instructions

Focus on:
- Key decisions
- Files modified
- Current task state

# Other Section

More content here.
`;

      const result = extractCompactInstructions(content);

      expect(result).toBeDefined();
      expect(result).toContain('Focus on:');
      expect(result).toContain('Key decisions');
      expect(result).not.toContain('Other Section');
    });

    it('should extract content from ## Compact Instructions heading', () => {
      const content = `
# Main Section

## Compact Instructions

Remember to preserve code context.

## Another Section

Other stuff.
`;

      const result = extractCompactInstructions(content);

      expect(result).toBeDefined();
      expect(result).toContain('Remember to preserve code context.');
      expect(result).not.toContain('Another Section');
    });

    it('should return undefined when no Compact Instructions section exists', () => {
      const content = `
# Project Guidelines

Some guidelines here.

# Development Notes

Some notes.
`;

      const result = extractCompactInstructions(content);

      expect(result).toBeUndefined();
    });

    it('should handle empty content', () => {
      const result = extractCompactInstructions('');

      expect(result).toBeUndefined();
    });

    it('should extract until end of file if no next heading', () => {
      const content = `
# Setup

Instructions.

# Compact Instructions

Final instructions that go to the end.
With multiple lines.
And no more headings after.
`;

      const result = extractCompactInstructions(content);

      expect(result).toBeDefined();
      expect(result).toContain('Final instructions that go to the end.');
      expect(result).toContain('And no more headings after.');
    });

    it('should be case insensitive for the heading', () => {
      const content = `
# COMPACT INSTRUCTIONS

Important: summarize the file changes.

# Next Section
`;

      const result = extractCompactInstructions(content);

      expect(result).toBeDefined();
      expect(result).toContain('Important: summarize the file changes.');
    });

    it('should handle # Compact Instructions with extra spaces', () => {
      const content = `
#   Compact   Instructions

Allow extra whitespace in heading.

# Next
`;

      const result = extractCompactInstructions(content);

      // The regex uses \s* which allows extra whitespace
      expect(result).toBeDefined();
      expect(result).toContain('Allow extra whitespace in heading.');
    });
  });
});
