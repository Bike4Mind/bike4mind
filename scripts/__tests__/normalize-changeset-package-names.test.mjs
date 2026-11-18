import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { normalize, main } from '../normalize-changeset-package-names.mjs';

describe('normalize', () => {
  it('renames a retired package in quoted and unquoted keys', () => {
    const input = '---\n"@bike4mind/common": minor\n"@bike4mind/services": minor\n---\n\nbody\n';
    expect(normalize(input)).toBe('---\n"@bike4mind/common": minor\n"@bike4mind/services-core": minor\n---\n\nbody\n');
    expect(normalize('---\n@bike4mind/services: patch\n---\nx\n')).toBe(
      '---\n@bike4mind/services-core: patch\n---\nx\n'
    );
  });

  it('keeps the auto-generated marker line and leaves the body alone', () => {
    const input =
      '<!-- auto-generated -->\n---\n"@bike4mind/services": major\n---\n\n"@bike4mind/services": in prose\n';
    expect(normalize(input)).toBe(
      '<!-- auto-generated -->\n---\n"@bike4mind/services-core": major\n---\n\n"@bike4mind/services": in prose\n'
    );
  });

  it('does not touch current names or files without frontmatter', () => {
    const current = '---\n"@bike4mind/services-core": minor\n"@bike4mind/services-utils": patch\n---\nx\n';
    expect(normalize(current)).toBe(current);
    expect(normalize('# README\n')).toBe('# README\n');
  });
});

describe('normalize edge cases', () => {
  it('renames single-quoted keys, CRLF files and a space before the colon', () => {
    expect(normalize("---\n'@bike4mind/services': patch\n---\nx\n")).toBe(
      "---\n'@bike4mind/services-core': patch\n---\nx\n"
    );
    expect(normalize('---\r\n"@bike4mind/services" : patch\r\n---\r\nx\r\n')).toBe(
      '---\r\n"@bike4mind/services-core" : patch\r\n---\r\nx\r\n'
    );
  });

  it('does not rewrite the body after empty frontmatter', () => {
    const input = '---\n---\n@bike4mind/services: x\n---\n';
    expect(normalize(input)).toBe(input);
  });

  it('ignores inherited property names', () => {
    const input = '---\ntoString: patch\n---\nx\n';
    expect(normalize(input)).toBe(input);
  });
});

describe('main', () => {
  it('rewrites only stale changesets and skips README.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changeset-'));
    const stale = '---\n"@bike4mind/services": patch\n---\nx\n';
    const current = '---\n"@bike4mind/services-core": patch\n---\ny\n';
    fs.writeFileSync(path.join(dir, 'a.md'), stale);
    fs.writeFileSync(path.join(dir, 'b.md'), current);
    fs.writeFileSync(path.join(dir, 'README.md'), stale);
    main(dir);
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe(stale.replace('services"', 'services-core"'));
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe(current);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe(stale);
    fs.rmSync(dir, { recursive: true });
  });
});
