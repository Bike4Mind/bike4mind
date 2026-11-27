// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExternalLinks } from '@client/app/utils/externalLinks';

const LEGAL_DIR = __dirname;
const read = (file: string) => readFileSync(path.join(LEGAL_DIR, file), 'utf8');

const frontmatterOf = (source: string): Record<string, string> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? '';
  return Object.fromEntries(
    block
      .split('\n')
      .filter(line => /^\w+:\s*\S/.test(line))
      .map(line => {
        const [key, ...rest] = line.split(':');
        return [
          key,
          rest
            .join(':')
            .trim()
            .replace(/^'(.*)'$/, '$1'),
        ];
      })
  );
};

// The app links each legal document on the marketing site by its file name; keep these in step.
const DOCUMENTS = [
  { file: 'terms-of-service.md', link: ExternalLinks.terms },
  { file: 'usage-policy.md', link: ExternalLinks.usagePolicy },
  { file: 'data-handling.md', link: ExternalLinks.dataHandling },
];

describe('legal document set', () => {
  it.each(DOCUMENTS)('$file carries the versioned frontmatter and is linked by its slug', ({ file, link }) => {
    const slug = file.replace(/\.md$/, '');
    const frontmatter = frontmatterOf(read(file));

    expect(frontmatter.type).toBe(slug);
    expect(frontmatter.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(frontmatter.title).toBeTruthy();
    expect(frontmatter.effectiveDate ?? frontmatter.lastUpdated).toBeTruthy();
    expect(frontmatter.status).toBeTruthy();
    expect(link.endsWith(`/${slug}`)).toBe(true);
  });

  it.each(DOCUMENTS)('$file is listed in the README document set', ({ file }) => {
    expect(read('README.md')).toContain(`[\`${file}\`](./${file})`);
  });

  it('keeps the data-handling statement ASCII-only', () => {
    expect(read('data-handling.md')).toMatch(/^[\x20-\x7e\n]*$/);
  });
});
