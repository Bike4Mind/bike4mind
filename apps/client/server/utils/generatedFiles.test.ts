// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { toGeneratedFiles } from './generatedFiles';

const ORIGINAL_CDN = process.env.NEXT_PUBLIC_CDN_URL;

afterEach(() => {
  process.env.NEXT_PUBLIC_CDN_URL = ORIGINAL_CDN;
});

describe('toGeneratedFiles', () => {
  it('builds fully-qualified CDN URLs under /generated', () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com';
    expect(toGeneratedFiles(['a1b2c3.png'])).toEqual([
      { name: 'a1b2c3.png', url: 'https://cdn.example.com/generated/a1b2c3.png', isImage: true },
    ]);
  });

  it('flags non-image files (e.g. .xlsx) with isImage: false', () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com';
    const [file] = toGeneratedFiles(['report.xlsx']);
    expect(file).toMatchObject({ name: 'report.xlsx', isImage: false });
  });

  it('normalizes a trailing slash on the CDN URL so paths never double-slash', () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com/';
    expect(toGeneratedFiles(['a.png'])[0].url).toBe('https://cdn.example.com/generated/a.png');
  });

  it('returns [] when no CDN is configured rather than a misleading relative path', () => {
    process.env.NEXT_PUBLIC_CDN_URL = '';
    expect(toGeneratedFiles(['a.png'])).toEqual([]);
  });

  it('recognizes common image extensions case-insensitively', () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.com';
    const files = toGeneratedFiles(['x.PNG', 'y.jpeg', 'z.WEBP', 'a.svg', 'b.txt']);
    expect(files.map(f => f.isImage)).toEqual([true, true, true, true, false]);
  });
});
