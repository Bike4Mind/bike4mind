import { describe, it, expect } from 'vitest';
import { ConfluenceExtractor } from './confluence';

describe('ConfluenceExtractor', () => {
  const extractor = new ConfluenceExtractor();

  describe('extract', () => {
    it('extracts Confluence page URL with space and title', () => {
      const text = 'Check https://company.atlassian.net/wiki/spaces/DOCS/pages/123456/Getting+Started';
      const result = extractor.extract(text, 'user');

      expect(result.entities).toHaveLength(2); // Page + Space
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'confluence_page',
          entity: { id: '123456', title: 'Getting Started', spaceKey: 'DOCS' },
        },
        source: 'user',
      });
      expect(result.entities[1]).toMatchObject({
        entity: {
          type: 'confluence_space',
          entity: { key: 'DOCS' },
        },
        source: 'user',
      });
    });

    it('extracts Confluence page URL without title', () => {
      const text = 'See https://acme.atlassian.net/wiki/spaces/DEV/pages/789012';
      const result = extractor.extract(text, 'tool_result');

      expect(result.entities).toHaveLength(2);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'confluence_page',
          entity: { id: '789012', title: 'Page 789012', spaceKey: 'DEV' },
        },
        source: 'tool_result',
      });
    });

    it('extracts Confluence space URL', () => {
      const text = 'See https://company.atlassian.net/wiki/spaces/TEAM/';
      const result = extractor.extract(text, 'assistant');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'confluence_space',
          entity: { key: 'TEAM' },
        },
        source: 'assistant',
      });
    });

    it('extracts space from context mention', () => {
      // Pattern expects "space KEY" format (word space followed by key)
      const text = 'Add this to the space DOCS';
      const result = extractor.extract(text, 'user');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'confluence_space',
          entity: { key: 'DOCS' },
        },
        source: 'user',
      });
    });

    it('extracts page ID from tool result', () => {
      const text = 'Created page with pageId: 456789';
      const result = extractor.extract(text, 'tool_result');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'confluence_page',
          entity: { id: '456789', title: 'Page 456789' },
        },
        source: 'tool_result',
      });
    });

    it('handles URL-encoded titles', () => {
      const text = 'https://company.atlassian.net/wiki/spaces/DEV/pages/111/API%20Documentation%20Guide';
      const result = extractor.extract(text, 'user');

      expect(result.entities[0]).toMatchObject({
        entity: {
          type: 'confluence_page',
          entity: { id: '111', title: 'API Documentation Guide' },
        },
      });
    });

    it('handles malformed URL encoding gracefully', () => {
      // %ZZ is invalid URL encoding
      const text = 'https://company.atlassian.net/wiki/spaces/DEV/pages/222/Bad%ZZEncoding';
      const result = extractor.extract(text, 'user');

      // Should not throw, and should use the raw string as fallback
      expect(result.entities).toHaveLength(2);
      expect(result.entities[0].entity.type).toBe('confluence_page');
    });

    it('deduplicates spaces from multiple pages', () => {
      const text = `
        https://company.atlassian.net/wiki/spaces/DOCS/pages/1/Page1
        https://company.atlassian.net/wiki/spaces/DOCS/pages/2/Page2
      `;
      const result = extractor.extract(text, 'user');

      const spaces = result.entities.filter(e => e.entity.type === 'confluence_space');
      expect(spaces).toHaveLength(1); // Only one DOCS space
    });

    it('deduplicates pages mentioned multiple times', () => {
      const text = `
        https://company.atlassian.net/wiki/spaces/DOCS/pages/123/SamePage
        See also pageId: 123
        https://company.atlassian.net/wiki/spaces/DOCS/pages/123/SamePage
      `;
      const result = extractor.extract(text, 'user');

      const pages = result.entities.filter(e => e.entity.type === 'confluence_page');
      expect(pages).toHaveLength(1); // Only one page with ID 123
    });

    it('extracts multiple entities from same text', () => {
      const text = `
        Page at https://company.atlassian.net/wiki/spaces/DEV/pages/100/DevPage
        Space at https://company.atlassian.net/wiki/spaces/TEAM/
      `;
      const result = extractor.extract(text, 'user');

      // Should have: page + DEV space, TEAM space
      expect(result.entities.length).toBeGreaterThanOrEqual(3);
    });
  });
});
