import { describe, expect, it } from 'vitest';
import { browserPageModelSchema, browserSnapshotSchema, type BrowserPageModel } from './browserPage';

function model(): BrowserPageModel {
  return {
    url: 'https://example.com/article',
    title: 'Article',
    capturedAt: '2026-10-24T12:00:00.000Z',
    blocks: [{ id: 'b1', kind: 'text', text: 'A verified statement.' }],
    actions: [{ ref: '1', kind: 'click', element: 'link', label: 'Source', href: '/source' }],
    claims: [{ id: 'c1', text: 'verified', source: { blockId: 'b1', start: 2, end: 10 } }],
    truncated: false,
  };
}

describe('browser page model', () => {
  it('validates a snapshot carrying the typed model beside its outline', () => {
    const page = model();
    expect(
      browserSnapshotSchema.parse({
        url: page.url,
        title: page.title,
        text: 'A verified statement.\n[1] link "Source" -> /source',
        truncated: false,
        model: page,
      }).model
    ).toEqual(page);
  });

  it('rejects duplicate refs and claims that do not match their source spans', () => {
    const page = model();
    page.actions.push({ ref: '1', kind: 'click', element: 'button', label: 'Duplicate' });
    page.claims[0] = { ...page.claims[0], text: 'unattributed' };

    const result = browserPageModelSchema.safeParse(page);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message)).toEqual(
        expect.arrayContaining(['Duplicate action ref 1', 'Claim text does not match its source span'])
      );
    }
  });
});

describe('claim source integrity', () => {
  it('rejects duplicate block and claim identifiers', () => {
    const page = model();
    page.blocks.push({ id: 'b1', kind: 'text', text: 'Other text' });
    expect(browserPageModelSchema.safeParse(page).success).toBe(false);
    const duplicateClaims = model();
    duplicateClaims.claims.push(duplicateClaims.claims[0]);
    expect(browserPageModelSchema.safeParse(duplicateClaims).success).toBe(false);
  });

  it('rejects spans beyond the source even when slice would clamp them', () => {
    const page = model();
    page.claims[0] = { id: 'c1', text: 'A verified statement.', source: { blockId: 'b1', start: 0, end: 100 } };
    expect(browserPageModelSchema.safeParse(page).success).toBe(false);
  });
});
