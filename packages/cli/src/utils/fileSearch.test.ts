import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPathWithinCwd, isBinaryFile } from './fileSearch.js';

describe('fileSearch utils', () => {
  describe('isPathWithinCwd', () => {
    beforeEach(() => {
      // Mock process.cwd to return a predictable path
      vi.spyOn(process, 'cwd').mockReturnValue('/home/user/project');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('valid paths within cwd', () => {
      it('should return true for a simple relative file path', () => {
        expect(isPathWithinCwd('file.txt')).toBe(true);
      });

      it('should return true for a nested relative path', () => {
        expect(isPathWithinCwd('src/utils/file.ts')).toBe(true);
      });

      it('should return true for current directory reference', () => {
        expect(isPathWithinCwd('.')).toBe(true);
      });

      it('should return true for path starting with ./', () => {
        expect(isPathWithinCwd('./src/file.ts')).toBe(true);
      });

      it('should return true for deeply nested path', () => {
        expect(isPathWithinCwd('a/b/c/d/e/file.js')).toBe(true);
      });
    });

    describe('path traversal attempts that should be blocked', () => {
      it('should return false for simple parent directory traversal', () => {
        expect(isPathWithinCwd('../file.txt')).toBe(false);
      });

      it('should return false for multiple parent directory traversal', () => {
        expect(isPathWithinCwd('../../etc/passwd')).toBe(false);
      });

      it('should return false for hidden traversal in middle of path', () => {
        expect(isPathWithinCwd('src/../../../etc/passwd')).toBe(false);
      });

      it('should return false for traversal that goes out and comes back in', () => {
        // This goes: /home/user/project/src -> /home/user/project -> /home/user -> /home -> /etc
        expect(isPathWithinCwd('src/../../../../../../etc/passwd')).toBe(false);
      });

      it('should return false for absolute paths outside cwd', () => {
        expect(isPathWithinCwd('/etc/passwd')).toBe(false);
      });

      it('should return false for absolute path to different directory', () => {
        expect(isPathWithinCwd('/home/other/file.txt')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should return true for path that goes up and back down into cwd', () => {
        // /home/user/project/src/.. resolves to /home/user/project
        expect(isPathWithinCwd('src/..')).toBe(true);
      });

      it('should return true for path with redundant ./ components', () => {
        expect(isPathWithinCwd('./././src/file.ts')).toBe(true);
      });

      it('should return false for path with null bytes (potential bypass attempt)', () => {
        // Path normalization should handle this, but the resolved path would be outside
        expect(isPathWithinCwd('../\0/etc/passwd')).toBe(false);
      });
    });

    describe('case sensitivity (Windows compatibility)', () => {
      it('should handle case variations on case-insensitive systems', () => {
        // The current implementation lowercases both paths for comparison
        // This test verifies the normalization works
        vi.spyOn(process, 'cwd').mockReturnValue('/HOME/USER/PROJECT');
        expect(isPathWithinCwd('file.txt')).toBe(true);
      });
    });

    describe('symlink resolution', () => {
      // Due to ESM limitations, fs.realpathSync.native cannot be mocked directly in tests.
      // These tests verify the expected behavior through integration-style testing.
      // The symlink resolution logic is tested by verifying that:
      // 1. Paths within cwd are allowed (even if they would be symlinks in production)
      // 2. Paths outside cwd are blocked
      // 3. Non-existent paths within cwd are allowed for autocomplete

      it('should allow paths within cwd that could be symlinked', () => {
        // Tests that relative paths within cwd are accepted
        // In production, these paths would be resolved through realpathSync
        expect(isPathWithinCwd('src/file.ts')).toBe(true);
        expect(isPathWithinCwd('./src/components/App.tsx')).toBe(true);
      });

      it('should block paths that traverse outside cwd', () => {
        // Even if a symlink tried to escape, path traversal is caught
        expect(isPathWithinCwd('../outside-project/file.ts')).toBe(false);
        expect(isPathWithinCwd('src/../../outside/malicious')).toBe(false);
      });

      it('should handle non-existent paths within cwd for autocomplete', () => {
        // Non-existent paths within cwd should be allowed for autocomplete suggestions
        // The implementation handles ENOENT gracefully by resolving relative to cwd
        expect(isPathWithinCwd('src/new-file-that-does-not-exist.ts')).toBe(true);
        expect(isPathWithinCwd('new-directory/new-file.js')).toBe(true);
      });
    });
  });

  describe('isBinaryFile', () => {
    describe('binary file extensions', () => {
      it('should return true for image files', () => {
        expect(isBinaryFile('photo.png')).toBe(true);
        expect(isBinaryFile('image.jpg')).toBe(true);
        expect(isBinaryFile('picture.jpeg')).toBe(true);
        expect(isBinaryFile('animation.gif')).toBe(true);
        expect(isBinaryFile('icon.ico')).toBe(true);
        expect(isBinaryFile('photo.webp')).toBe(true);
        expect(isBinaryFile('bitmap.bmp')).toBe(true);
      });

      it('should return true for document files', () => {
        expect(isBinaryFile('document.pdf')).toBe(true);
        expect(isBinaryFile('file.doc')).toBe(true);
        expect(isBinaryFile('file.docx')).toBe(true);
        expect(isBinaryFile('spreadsheet.xls')).toBe(true);
        expect(isBinaryFile('spreadsheet.xlsx')).toBe(true);
        expect(isBinaryFile('presentation.ppt')).toBe(true);
        expect(isBinaryFile('presentation.pptx')).toBe(true);
      });

      it('should return true for archive files', () => {
        expect(isBinaryFile('archive.zip')).toBe(true);
        expect(isBinaryFile('archive.tar')).toBe(true);
        expect(isBinaryFile('archive.gz')).toBe(true);
        expect(isBinaryFile('archive.rar')).toBe(true);
        expect(isBinaryFile('archive.7z')).toBe(true);
      });

      it('should return true for executable/binary files', () => {
        expect(isBinaryFile('program.exe')).toBe(true);
        expect(isBinaryFile('library.dll')).toBe(true);
        expect(isBinaryFile('library.so')).toBe(true);
        expect(isBinaryFile('library.dylib')).toBe(true);
        expect(isBinaryFile('data.bin')).toBe(true);
      });

      it('should return true for media files', () => {
        expect(isBinaryFile('audio.mp3')).toBe(true);
        expect(isBinaryFile('video.mp4')).toBe(true);
        expect(isBinaryFile('sound.wav')).toBe(true);
        expect(isBinaryFile('movie.avi')).toBe(true);
        expect(isBinaryFile('clip.mov')).toBe(true);
        expect(isBinaryFile('video.mkv')).toBe(true);
      });

      it('should return true for font files', () => {
        expect(isBinaryFile('font.ttf')).toBe(true);
        expect(isBinaryFile('font.otf')).toBe(true);
        expect(isBinaryFile('font.woff')).toBe(true);
        expect(isBinaryFile('font.woff2')).toBe(true);
        expect(isBinaryFile('font.eot')).toBe(true);
      });

      it('should return true for compiled files', () => {
        expect(isBinaryFile('Program.class')).toBe(true);
        expect(isBinaryFile('module.pyc')).toBe(true);
        expect(isBinaryFile('object.o')).toBe(true);
        expect(isBinaryFile('object.obj')).toBe(true);
      });
    });

    describe('text file extensions', () => {
      it('should return false for source code files', () => {
        expect(isBinaryFile('script.js')).toBe(false);
        expect(isBinaryFile('component.tsx')).toBe(false);
        expect(isBinaryFile('module.ts')).toBe(false);
        expect(isBinaryFile('script.py')).toBe(false);
        expect(isBinaryFile('Main.java')).toBe(false);
        expect(isBinaryFile('program.go')).toBe(false);
        expect(isBinaryFile('lib.rs')).toBe(false);
      });

      it('should return false for config/data files', () => {
        expect(isBinaryFile('config.json')).toBe(false);
        expect(isBinaryFile('data.yaml')).toBe(false);
        expect(isBinaryFile('settings.yml')).toBe(false);
        expect(isBinaryFile('config.toml')).toBe(false);
        expect(isBinaryFile('data.xml')).toBe(false);
      });

      it('should return false for documentation files', () => {
        expect(isBinaryFile('README.md')).toBe(false);
        expect(isBinaryFile('CHANGELOG.txt')).toBe(false);
        expect(isBinaryFile('LICENSE')).toBe(false);
      });

      it('should return false for web files', () => {
        expect(isBinaryFile('index.html')).toBe(false);
        expect(isBinaryFile('styles.css')).toBe(false);
        expect(isBinaryFile('styles.scss')).toBe(false);
      });
    });

    describe('case insensitivity', () => {
      it('should handle uppercase extensions', () => {
        expect(isBinaryFile('IMAGE.PNG')).toBe(true);
        expect(isBinaryFile('DOCUMENT.PDF')).toBe(true);
      });

      it('should handle mixed case extensions', () => {
        expect(isBinaryFile('Photo.Jpg')).toBe(true);
        expect(isBinaryFile('Script.Js')).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle files with multiple dots', () => {
        expect(isBinaryFile('archive.tar.gz')).toBe(true);
        expect(isBinaryFile('config.prod.json')).toBe(false);
      });

      it('should handle files with paths', () => {
        expect(isBinaryFile('src/images/logo.png')).toBe(true);
        expect(isBinaryFile('src/utils/helper.ts')).toBe(false);
      });

      it('should handle hidden files', () => {
        expect(isBinaryFile('.gitignore')).toBe(false);
        expect(isBinaryFile('.env')).toBe(false);
      });

      it('should return false for SVG (XML text format, useful for code review)', () => {
        // SVG is NOT in the binary list because it's actually a text-based XML format
        // that can be safely read and is useful for code review
        expect(isBinaryFile('icon.svg')).toBe(false);
      });
    });
  });
});
