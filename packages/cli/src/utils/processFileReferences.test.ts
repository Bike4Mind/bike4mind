import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { processFileReferences, hasFileReferences, extractFileReferences } from './processFileReferences.js';

// Mock the fs module
vi.mock('node:fs');

describe('processFileReferences', () => {
  describe('extractFileReferences', () => {
    describe('valid file path patterns', () => {
      it('should extract path with forward slash', () => {
        const result = extractFileReferences('Check @src/utils/file.ts for details');
        expect(result).toEqual(['src/utils/file.ts']);
      });

      it('should extract path with file extension', () => {
        // Use .txt instead of .md since .md is excluded as a name suffix (Medical Doctor)
        const result = extractFileReferences('Look at @README.txt');
        expect(result).toEqual(['README.txt']);
      });

      it('should extract multiple file references', () => {
        const result = extractFileReferences('@file1.ts and @src/file2.js are related');
        expect(result).toEqual(['file1.ts', 'src/file2.js']);
      });

      it('should extract path at the start of message', () => {
        const result = extractFileReferences('@package.json contains the config');
        expect(result).toEqual(['package.json']);
      });

      it('should extract path with dots in filename', () => {
        const result = extractFileReferences('Check @config.prod.json');
        expect(result).toEqual(['config.prod.json']);
      });

      it('should extract hidden files starting with dot', () => {
        const result = extractFileReferences('See @.gitignore for patterns');
        expect(result).toEqual(['.gitignore']);
      });

      it('should extract path starting with ./', () => {
        const result = extractFileReferences('Look at @./src/index.ts');
        expect(result).toEqual(['./src/index.ts']);
      });

      it('should extract deeply nested paths', () => {
        const result = extractFileReferences('@src/components/ui/Button/index.tsx');
        expect(result).toEqual(['src/components/ui/Button/index.tsx']);
      });
    });

    describe('email addresses should NOT be extracted', () => {
      it('should not extract email after @ in text', () => {
        const result = extractFileReferences('Contact @user at user@example.com');
        // Only @user would match if it looked like a path, but it doesn't have / or .extension
        expect(result).toEqual([]);
      });

      it('should not extract email-like patterns', () => {
        const result = extractFileReferences('Email me at @john');
        expect(result).toEqual([]);
      });

      it('should not extract username mentions without path indicators', () => {
        const result = extractFileReferences('@username please review this');
        expect(result).toEqual([]);
      });

      it('should not extract simple word after @', () => {
        const result = extractFileReferences('Hello @world');
        expect(result).toEqual([]);
      });
    });

    describe('distinguishing emails from file paths', () => {
      it('should extract file but not email in same message', () => {
        const result = extractFileReferences('@config.json email: test@example.com');
        expect(result).toEqual(['config.json']);
      });

      it('should not be confused by @ in the middle of a word', () => {
        // @ in middle of word (like email) should not trigger
        const result = extractFileReferences('Send to user@domain.com');
        expect(result).toEqual([]);
      });

      it('should extract path-like reference after email mention', () => {
        const result = extractFileReferences('Contact admin@example.com and check @docs/guide.md');
        expect(result).toEqual(['docs/guide.md']);
      });
    });

    describe('human name suffixes should NOT be treated as file extensions', () => {
      it('should not extract @user.jr as a file reference', () => {
        const result = extractFileReferences('Talk to @john.jr about the issue');
        expect(result).toEqual([]);
      });

      it('should not extract @user.sr as a file reference', () => {
        const result = extractFileReferences('Ask @bob.sr for approval');
        expect(result).toEqual([]);
      });

      it('should not extract @user.phd as a file reference', () => {
        const result = extractFileReferences('Dr. @smith.phd reviewed this');
        expect(result).toEqual([]);
      });

      it('should not extract @user.md as a file reference (common name suffix)', () => {
        const result = extractFileReferences('Consult @jones.md about the diagnosis');
        expect(result).toEqual([]);
      });

      it('should not extract @user.esq as a file reference', () => {
        const result = extractFileReferences('The lawyer @doe.esq will handle it');
        expect(result).toEqual([]);
      });

      it('should not extract Roman numeral suffixes (ii, iii, iv, v)', () => {
        expect(extractFileReferences('@king.ii is here')).toEqual([]);
        expect(extractFileReferences('@prince.iii arrived')).toEqual([]);
        expect(extractFileReferences('@duke.iv requested')).toEqual([]);
        expect(extractFileReferences('@earl.v approved')).toEqual([]);
      });

      it('should not extract very long extensions (over 10 chars)', () => {
        const result = extractFileReferences('@username.verylongextension');
        expect(result).toEqual([]);
      });

      it('should still extract real file extensions even if short', () => {
        // .js, .ts, .py etc. should still work
        expect(extractFileReferences('@script.js')).toEqual(['script.js']);
        expect(extractFileReferences('@module.ts')).toEqual(['module.ts']);
      });

      it('should not extract .md extension (conflicts with Medical Doctor suffix)', () => {
        // .md is excluded because it's a common name suffix (Medical Doctor)
        // Users who want to reference markdown files should use paths like @docs/README.md
        expect(extractFileReferences('@README.md')).toEqual([]);
        // But with a path, it works
        expect(extractFileReferences('@docs/README.md')).toEqual(['docs/README.md']);
      });

      it('should extract file with path even if filename looks like name suffix', () => {
        // If there's a path separator, it's definitely a file path
        const result = extractFileReferences('Check @docs/john.jr.txt');
        expect(result).toEqual(['docs/john.jr.txt']);
      });
    });

    describe('edge cases', () => {
      it('should return empty array for message without @', () => {
        const result = extractFileReferences('No references here');
        expect(result).toEqual([]);
      });

      it('should return empty array for empty message', () => {
        const result = extractFileReferences('');
        expect(result).toEqual([]);
      });

      it('should handle @ at end of message with no following text', () => {
        // This would not have any text after @ so nothing to extract
        const result = extractFileReferences('Test @');
        expect(result).toEqual([]);
      });

      it('should not extract if @ is followed by space immediately', () => {
        const result = extractFileReferences('Test @ file.txt');
        expect(result).toEqual([]);
      });
    });
  });

  describe('hasFileReferences', () => {
    it('should return true for message with file reference', () => {
      expect(hasFileReferences('Check @src/file.ts')).toBe(true);
    });

    it('should return true for message with .extension reference', () => {
      expect(hasFileReferences('See @README.md')).toBe(true);
    });

    it('should return false for message without @ at all', () => {
      expect(hasFileReferences('No references here')).toBe(false);
    });

    it('should return true even for email-like patterns (regex still matches)', () => {
      // Note: hasFileReferences uses a simpler regex that matches any @word
      // The filtering happens in extractFileReferences
      expect(hasFileReferences('Email @user or contact@example.com')).toBe(true);
    });
  });

  describe('processFileReferences', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      vi.spyOn(process, 'cwd').mockReturnValue('/home/user/project');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('successful file injection', () => {
      it('should inject file contents for valid file reference', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          isFile: () => true,
          size: 100,
        } as fs.Stats);
        vi.mocked(fs.readFileSync).mockReturnValue('file contents here');

        const result = await processFileReferences('Check @test.txt');

        expect(result.content).toContain('Check @test.txt');
        expect(result.content).toContain('file contents here');
        expect(result.content).toContain('--- Referenced File: test.txt');
        expect(result.errors).toEqual([]);
      });

      it('should inject multiple files', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          isFile: () => true,
          size: 50,
        } as fs.Stats);
        vi.mocked(fs.readFileSync).mockReturnValueOnce('content 1').mockReturnValueOnce('content 2');

        const result = await processFileReferences('@file1.ts and @file2.ts');

        expect(result.content).toContain('content 1');
        expect(result.content).toContain('content 2');
        expect(result.errors).toEqual([]);
      });

      it('should allow explicit absolute paths', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          isFile: () => true,
          size: 200,
        } as fs.Stats);
        vi.mocked(fs.readFileSync).mockReturnValue('absolute path contents');

        const result = await processFileReferences('Check @/Users/erik/Downloads/file.md');

        expect(result.content).toContain('absolute path contents');
        expect(result.content).toContain('--- Referenced File: /Users/erik/Downloads/file.md');
        expect(result.errors).toEqual([]);
      });

      it('should allow explicit absolute paths without traversal', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          isFile: () => true,
          size: 150,
        } as fs.Stats);
        vi.mocked(fs.readFileSync).mockReturnValue('config contents');

        const result = await processFileReferences('Load @/etc/app/config.json');

        expect(result.content).toContain('config contents');
        expect(result.errors).toEqual([]);
      });
    });

    describe('directory handling', () => {
      it('should handle directory references with item count', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => true,
          isFile: () => false,
          size: 0,
        } as fs.Stats);
        (vi.mocked(fs.readdirSync) as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
          'file1.ts',
          'file2.ts',
          'subdir',
        ]);

        const result = await processFileReferences('Check @src/');

        expect(result.content).toContain('Directory with 3 items');
        expect(result.errors).toEqual([]);
      });
    });

    describe('error cases', () => {
      it('should return error for non-existent file', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);

        const result = await processFileReferences('Check @nonexistent.txt');

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('File not found');
      });

      it('should return error for relative path traversal attempt', async () => {
        const result = await processFileReferences('Check @../../../etc/passwd');

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Security');
        expect(result.errors[0]).toContain('Path traversal detected');
      });

      it('should return error for absolute path with traversal components', async () => {
        const result = await processFileReferences('Check @/Users/erik/../../../etc/passwd');

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Security');
        expect(result.errors[0]).toContain('Path traversal detected');
      });

      it('should return error for path traversal in relative path within cwd', async () => {
        const result = await processFileReferences('Check @src/../../../etc/passwd');

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Security');
        expect(result.errors[0]).toContain('Path traversal detected');
      });

      it('should return error for binary file', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          isFile: () => true,
          size: 1000,
        } as fs.Stats);

        const result = await processFileReferences('Check @image.png');

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('Binary file');
      });

      it('should return error for file exceeding size limit', async () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          isFile: () => true,
          size: 20 * 1024 * 1024, // 20MB, exceeds 10MB limit
        } as fs.Stats);

        const result = await processFileReferences('Check @largefile.txt');

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('File too large');
      });
    });

    describe('no file references', () => {
      it('should return original message when no file references found', async () => {
        const message = 'Just a regular message without file refs';
        const result = await processFileReferences(message);

        expect(result.content).toBe(message);
        expect(result.errors).toEqual([]);
      });

      it('should not process email-like patterns', async () => {
        const message = 'Contact @admin or email admin@example.com';
        const result = await processFileReferences(message);

        // Should return original since @admin is not a path-like reference
        expect(result.content).toBe(message);
        expect(result.errors).toEqual([]);
      });
    });
  });
});
