import { describe, it, expect } from 'vitest';
import { MODEL_PROVIDERS, type SettingKey } from '@bike4mind/common';
import {
  countLine,
  deriveGallery,
  filterIntegrations,
  filterModels,
  galleryCounts,
  groupIntegrations,
  groupModels,
  type GalleryViewer,
} from './galleryModel';

const viewer = (overrides: Partial<GalleryViewer> & { flags?: SettingKey[] } = {}): GalleryViewer => {
  const flags = new Set<SettingKey>(overrides.flags ?? ['EnableMCPServer', 'EnableDataLakes', 'EnableEmailAnalysis']);
  return {
    isFlagOn: key => flags.has(key),
    isAdmin: overrides.isAdmin ?? false,
    canAccessTavern: overrides.canAccessTavern ?? false,
  };
};

const ids = (rows: { integration: { id: string } }[]) => rows.map(r => r.integration.id);

describe('deriveGallery', () => {
  it('leaves out admin-only and Tavern-only entries for viewers without that access', () => {
    expect(ids(deriveGallery(viewer(), {}))).not.toContain('blog');
    expect(ids(deriveGallery(viewer(), {}))).not.toContain('claude-code');
    expect(ids(deriveGallery(viewer({ isAdmin: true }), {}))).toContain('blog');
    expect(ids(deriveGallery(viewer({ canAccessTavern: true }), {}))).toContain('claude-code');
  });

  it('marks connected entries Connected', () => {
    const rows = deriveGallery(viewer(), { notion: { connected: true } });
    expect(rows.find(r => r.integration.id === 'notion')?.status).toBe('connected');
  });
});

describe('groupIntegrations', () => {
  it('pins Connected first, groups live entries by category, and puts the roadmap last', () => {
    const groups = groupIntegrations(deriveGallery(viewer(), { 'google-drive': { connected: true } }));
    const keys = groups.map(g => g.key);
    expect(keys[0]).toBe('connected');
    expect(keys[keys.length - 1]).toBe('coming-soon');
    expect(ids(groups[0].rows)).toEqual(['google-drive']);
    expect(groups.find(g => g.key === 'files')).toBeUndefined();
    expect(groups.find(g => g.key === 'coming-soon')?.roadmap).toBe(true);
    expect(ids(groups.find(g => g.key === 'dev-tools')!.rows)).toEqual(['github', 'jupyter', 'mcp-cli']);
  });

  it('files a flagged-off entry under the roadmap for a non-admin', () => {
    const groups = groupIntegrations(deriveGallery(viewer({ flags: [] }), {}));
    expect(ids(groups.find(g => g.key === 'coming-soon')!.rows)).toEqual(
      expect.arrayContaining(['notion', 'linkedin', 'google-calendar', 'hubspot'])
    );
  });
});

describe('filterIntegrations', () => {
  const rows = deriveGallery(viewer(), { linkedin: { connected: true } });

  it('searches names, descriptions, categories and capability labels', () => {
    expect(ids(filterIntegrations(rows, { query: 'notion', category: 'all', status: 'all' }))).toEqual(['notion']);
    expect(ids(filterIntegrations(rows, { query: 'pull requests', category: 'all', status: 'all' }))).toContain(
      'github'
    );
    expect(ids(filterIntegrations(rows, { query: 'CRM', category: 'all', status: 'all' }))).toEqual([
      'hubspot',
      'salesforce',
    ]);
  });

  it('filters by category and status, and Beta also finds a connected beta', () => {
    expect(ids(filterIntegrations(rows, { query: '', category: 'identity', status: 'all' }))).toEqual([
      'okta',
      'b4m-oauth',
    ]);
    const beta = ids(filterIntegrations(rows, { query: '', category: 'all', status: 'beta' }));
    expect(beta).toContain('linkedin');
    expect(beta).not.toContain('github');
  });
});

describe('counts', () => {
  it('counts live entries, models and the roadmap for the count line', () => {
    // Google Calendar's flag is off for this viewer, so it joins the 18 planned entries.
    const counts = galleryCounts(deriveGallery(viewer(), {}));
    expect(counts).toEqual({ integrations: 12, models: MODEL_PROVIDERS.length, roadmap: 19 });
    expect(countLine(counts)).toBe(`12 integrations, ${MODEL_PROVIDERS.length} models, 19 on the roadmap`);
    expect(countLine({ integrations: 1, models: 1, roadmap: 0 })).toBe('1 integration, 1 model, 0 on the roadmap');
  });
});

describe('models', () => {
  it('filters by kind and query and groups chat first', () => {
    expect(groupModels(MODEL_PROVIDERS).map(g => g.key)).toEqual(['chat', 'image', 'video', 'music', 'voice']);
    expect(filterModels(MODEL_PROVIDERS, { query: '', kind: 'video' }).map(m => m.id)).toEqual(['veo']);
    expect(filterModels(MODEL_PROVIDERS, { query: 'grok', kind: 'all' }).map(m => m.id)).toEqual(['xai']);
  });
});
