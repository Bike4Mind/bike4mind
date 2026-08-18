import { describe, it, expect } from 'vitest';
import { isSupportedFabFileMimeType, SupportedFabFileMimeTypes } from '@bike4mind/common';
import {
  parseFilesToTree,
  getAllFiles,
  toggleFolderExclusion,
  reapplyExclusions,
  type FolderTreeNode,
} from './folderTreeParser';

// parseFilesToTree assigns each file `file.type || guessMimeType(name)`. The
// wizard's unsupported-type gate keys on that resolved type, so these
// tests lock in that supported extensions resolve to a SupportedFabFileMimeType
// while unsupported/binary ones fall through to octet-stream (rejected).
function file(name: string, type = ''): File {
  return new File(['content'], name, { type });
}

function resolvedType(name: string, type = ''): string {
  const tree = parseFilesToTree([file(name, type)], []);
  return getAllFiles(tree)[0].type;
}

describe('folderTreeParser guessMimeType (via parseFilesToTree)', () => {
  it('resolves supported code/text extensions to a supported MIME type when the browser type is empty', () => {
    expect(resolvedType('main.py')).toBe(SupportedFabFileMimeTypes.PY);
    expect(resolvedType('app.ts')).toBe(SupportedFabFileMimeTypes.TS);
    expect(resolvedType('index.js')).toBe(SupportedFabFileMimeTypes.JS);
    expect(resolvedType('config.yaml')).toBe(SupportedFabFileMimeTypes.YAML);
    expect(resolvedType('notes.md')).toBe(SupportedFabFileMimeTypes.TXT_MARKDOWN);

    expect(isSupportedFabFileMimeType(resolvedType('main.py'))).toBe(true);
  });

  it('leaves unsupported/binary types as octet-stream so the wizard gate skips them', () => {
    expect(resolvedType('malware.exe')).toBe('application/octet-stream');
    expect(resolvedType('archive.zip')).toBe('application/octet-stream');
    expect(isSupportedFabFileMimeType(resolvedType('malware.exe'))).toBe(false);
  });

  it('honors a real browser-provided MIME type over the extension guess', () => {
    expect(resolvedType('doc.pdf', 'application/pdf')).toBe(SupportedFabFileMimeTypes.PDF);
  });
});

/**
 * Excluding a folder has to reach WizardFile.excluded, not just the tree node. The Preview
 * tree and computeCounts read the node flag, but the source-step summary, the Config file
 * count and useBatchUpload all filter allFiles on the per-file flag - so a folder the user
 * unticked used to grey out in the tree while its files uploaded anyway.
 */
function folderFile(relativePath: string): File {
  const f = new File(['content'], relativePath.split('/').pop() as string, { type: 'text/plain' });
  Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
  return f;
}

const CORPUS = () =>
  parseFilesToTree(
    [
      folderFile('corpus/docs/a.txt'),
      folderFile('corpus/docs/b.txt'),
      folderFile('corpus/notes/c.txt'),
      folderFile('corpus/notes/.DS_Store'),
    ],
    ['.DS_Store']
  );

const includedPaths = (tree: FolderTreeNode) =>
  getAllFiles(tree)
    .filter(f => !f.excluded)
    .map(f => f.relativePath)
    .sort();

describe('folderTreeParser folder exclusion propagates to files', () => {
  it('marks every file under an excluded folder as excluded', () => {
    const excluded = toggleFolderExclusion(CORPUS(), 'corpus/notes', ['.DS_Store']);

    expect(includedPaths(excluded)).toEqual(['corpus/docs/a.txt', 'corpus/docs/b.txt']);
  });

  it('restores the folder files on re-include without resurrecting pattern-excluded junk', () => {
    const patterns = ['.DS_Store'];
    const off = toggleFolderExclusion(CORPUS(), 'corpus/notes', patterns);
    const backOn = toggleFolderExclusion(off, 'corpus/notes', patterns);

    expect(includedPaths(backOn)).toEqual(['corpus/docs/a.txt', 'corpus/docs/b.txt', 'corpus/notes/c.txt']);
  });

  it('keeps a hand-excluded folder excluded when patterns are re-applied', () => {
    // reapplyExclusions used to recompute every folder flag purely from the patterns, which
    // silently re-included a folder the user had unticked.
    const off = toggleFolderExclusion(CORPUS(), 'corpus/notes', ['.DS_Store']);
    const repatterned = reapplyExclusions(off, ['.DS_Store', '*.tmp']);

    expect(includedPaths(repatterned)).toEqual(['corpus/docs/a.txt', 'corpus/docs/b.txt']);
  });

  it('keeps the tree counts and the per-file flags telling the same story', () => {
    const excluded = toggleFolderExclusion(CORPUS(), 'corpus/notes', ['.DS_Store']);

    expect(excluded.fileCount).toBe(includedPaths(excluded).length);
  });
});
