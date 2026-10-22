import { describe, it, expect } from 'vitest';
import path from 'path';
import { isPathAccessDenial, deriveGrantDirectory } from './execution.js';

describe('isPathAccessDenial', () => {
  it('detects the file-tool allow-list denial (returned as a string)', () => {
    expect(
      isPathAccessDenial(
        'Error reading file: Access denied: Cannot read files outside allowed directories. Working directory: /a'
      )
    ).toBe(true);
  });

  it('detects denials for each file operation verb', () => {
    for (const op of ['read', 'create', 'edit', 'delete', 'access']) {
      expect(isPathAccessDenial(`Access denied: Cannot ${op} files outside allowed directories.`)).toBe(true);
    }
  });

  it('detects the grep_search path-validation denial (thrown)', () => {
    expect(
      isPathAccessDenial(
        'Path validation failed: "/elsewhere" resolves outside allowed directories. Working directory: /a'
      )
    ).toBe(true);
  });

  it("detects the glob_files denial, which omits the word 'files'", () => {
    // core glob_files throws `Access denied: Cannot search outside allowed directories.`
    expect(isPathAccessDenial('Access denied: Cannot search outside allowed directories. Working directory: /a')).toBe(
      true
    );
  });

  it('does not flag ordinary tool output or unrelated errors', () => {
    expect(isPathAccessDenial('Error reading file: ENOENT: no such file or directory')).toBe(false);
    expect(isPathAccessDenial('Found 3 matches in 2 files')).toBe(false);
    expect(isPathAccessDenial('')).toBe(false);
  });
});

describe('deriveGrantDirectory', () => {
  it('grants the parent directory for file-targeting tools', () => {
    const abs = path.join(path.parse(process.cwd()).root, 'somewhere', 'proj', 'file.ts');
    expect(deriveGrantDirectory('file_read', { path: abs })).toBe(path.dirname(abs));
    expect(deriveGrantDirectory('create_file', { path: abs })).toBe(path.dirname(abs));
    expect(deriveGrantDirectory('edit_local_file', { path: abs })).toBe(path.dirname(abs));
    expect(deriveGrantDirectory('delete_file', { path: abs })).toBe(path.dirname(abs));
  });

  it('grants the directory itself for grep_search / glob_files', () => {
    const dir = path.join(path.parse(process.cwd()).root, 'somewhere', 'proj');
    expect(deriveGrantDirectory('grep_search', { dir_path: dir })).toBe(dir);
    expect(deriveGrantDirectory('glob_files', { dir_path: dir })).toBe(dir);
  });

  it('resolves relative paths against the current working directory', () => {
    expect(deriveGrantDirectory('grep_search', { dir_path: 'sub/dir' })).toBe(path.resolve(process.cwd(), 'sub/dir'));
    expect(deriveGrantDirectory('file_read', { path: 'sub/file.ts' })).toBe(
      path.dirname(path.resolve(process.cwd(), 'sub/file.ts'))
    );
  });

  it('returns null when no usable path argument is present', () => {
    expect(deriveGrantDirectory('file_read', {})).toBeNull();
    expect(deriveGrantDirectory('grep_search', { dir_path: '' })).toBeNull();
    expect(deriveGrantDirectory('file_read', { path: 123 as unknown as string })).toBeNull();
  });
});
