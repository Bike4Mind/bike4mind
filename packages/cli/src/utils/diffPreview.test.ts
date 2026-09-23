import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateEditLocalFilePreview } from './diffPreview';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('generateEditLocalFilePreview shows the real matched span', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'diff-preview-'));
    file = join(dir, 'f.ts');
    // Tab-indented body: the model's un-indented old_string is NOT a literal
    // substring, so the tool resolves it via the fuzzy (line-trimmed) matcher and
    // actually deletes the tab-indented lines.
    await writeFile(file, 'function a() {\n\tconst x = 1;\n\treturn x;\n}\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('previews the file span the fuzzy matcher will delete, not the typed old_string', async () => {
    const args = {
      path: file,
      old_string: 'const x = 1;\nreturn x;',
      new_string: 'const total = 1;\nreturn total;',
    };
    const previewReal = await generateEditLocalFilePreview(args);
    // Control: with no file to match against, it falls back to the typed strings.
    const previewFallback = await generateEditLocalFilePreview({ ...args, path: '/nonexistent/does-not-exist.ts' });

    expect(previewReal).toContain('const x = 1;');
    // The real preview reflects the file's actual (tab-indented) span, so it must
    // differ from the naive old_string-only diff.
    expect(previewReal).not.toEqual(previewFallback);
  });
});
