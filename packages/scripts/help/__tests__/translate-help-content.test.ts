import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import {
  hashSource,
  stripCodeFence,
  translatableFields,
  buildTranslatedFrontmatter,
  needsTranslation,
  parseArgs,
} from '../translate-help-content';

describe('translate-help-content pure helpers', () => {
  describe('hashSource', () => {
    it('is stable for identical input and differs when content changes', () => {
      const a = hashSource('# Hello\n\nWorld');
      expect(a).toEqual(hashSource('# Hello\n\nWorld'));
      expect(a).not.toEqual(hashSource('# Hello\n\nChanged'));
    });
  });

  describe('stripCodeFence', () => {
    it('removes a wrapping ```json fence', () => {
      expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });
    it('removes a wrapping ```markdown fence', () => {
      expect(stripCodeFence('```markdown\n# Hola\n```')).toBe('# Hola');
    });
    it('leaves unfenced text untouched', () => {
      expect(stripCodeFence('# Hola\n\nMundo')).toBe('# Hola\n\nMundo');
    });
  });

  describe('translatableFields', () => {
    it('picks only present non-empty string fields', () => {
      expect(
        translatableFields({ title: 'Notebooks', description: 'Manage them', sidebar_position: 3, tags: ['a'] })
      ).toEqual({ title: 'Notebooks', description: 'Manage them' });
    });
    it('includes sidebar_label when present and skips blank strings', () => {
      expect(translatableFields({ title: 'T', description: '   ', sidebar_label: 'Docs' })).toEqual({
        title: 'T',
        sidebar_label: 'Docs',
      });
    });
  });

  describe('buildTranslatedFrontmatter', () => {
    it('overlays translated fields and stamps provenance while preserving other keys', () => {
      const fm = buildTranslatedFrontmatter(
        { title: 'Notebooks', description: 'Manage them', sidebar_position: 2, tags: ['x'] },
        { title: 'Cuadernos', description: 'Gestionalos' },
        'abc123'
      );
      expect(fm.title).toBe('Cuadernos');
      expect(fm.description).toBe('Gestionalos');
      expect(fm.sidebar_position).toBe(2);
      expect(fm.tags).toEqual(['x']);
      expect(fm.sourceHash).toBe('abc123');
      expect(fm.translatedFrom).toBe('en');
    });
  });

  describe('needsTranslation', () => {
    const hash = 'deadbeef';
    it('translates when the target is missing', () => {
      expect(needsTranslation(null, hash, false)).toBe(true);
    });
    it('skips when the recorded source hash matches', () => {
      const existing = matter.stringify('cuerpo', { title: 'x', sourceHash: hash });
      expect(needsTranslation(existing, hash, false)).toBe(false);
    });
    it('re-translates when the source hash differs', () => {
      const existing = matter.stringify('cuerpo', { title: 'x', sourceHash: 'stale' });
      expect(needsTranslation(existing, hash, false)).toBe(true);
    });
    it('always translates under --force', () => {
      const existing = matter.stringify('cuerpo', { title: 'x', sourceHash: hash });
      expect(needsTranslation(existing, hash, true)).toBe(true);
    });
    it('re-translates when the existing file has no parseable frontmatter hash', () => {
      expect(needsTranslation('no frontmatter here', hash, false)).toBe(true);
    });
  });

  describe('parseArgs', () => {
    it('separates locales from flags', () => {
      expect(parseArgs(['es', 'ja', '--force'])).toEqual({ locales: ['es', 'ja'], force: true });
    });
    it('defaults force to false and locales to empty', () => {
      expect(parseArgs([])).toEqual({ locales: [], force: false });
    });
  });
});
