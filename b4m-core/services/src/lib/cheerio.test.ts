import { describe, it, expect } from 'vitest';
import { getLinksFromHtml } from './cheerio';

describe('cheerio utils', () => {
  describe('getLinksFromHtml', () => {
    it('should extract links from anchor tags', () => {
      const html = `
        <div>
          <a href="https://example.com">Example</a>
          <a href="https://test.com/doc.pdf">Download PDF</a>
        </div>
      `;

      const links = getLinksFromHtml(html);
      expect(links).toHaveLength(2);
      expect(links).toEqual(['https://example.com', 'https://test.com/doc.pdf']);
    });

    it('should extract links from li elements with link attribute', () => {
      const html = `
        <ul>
          <li link="https://example.com">List Item 1</li>
          <li link="https://test.com/file.xlsx">List Item 2</li>
        </ul>
      `;

      const links = getLinksFromHtml(html);
      expect(links).toHaveLength(2);
      expect(links).toEqual(['https://example.com', 'https://test.com/file.xlsx']);
    });

    it('should handle office document preview links', () => {
      const html = `
        <div>
          <a href="https://view.officeapps.live.com/op/view.aspx?src=https://example.com/doc.docx">Office Doc</a>
        </div>
      `;

      const links = getLinksFromHtml(html);
      expect(links).toHaveLength(1);
      expect(links).toEqual(['https://example.com/doc.docx']);
    });

    it('should ignore links in header, footer, and nav', () => {
      const html = `
        <header>
          <a href="https://header.com">Header Link</a>
        </header>
        <nav>
          <a href="https://nav.com">Nav Link</a>
        </nav>
        <main>
          <a href="https://main.com">Main Link</a>
        </main>
        <footer>
          <a href="https://footer.com">Footer Link</a>
        </footer>
      `;

      const links = getLinksFromHtml(html);
      expect(links).toHaveLength(1);
      expect(links).toEqual(['https://main.com']);
    });

    it('should handle empty HTML', () => {
      const html = '';
      const links = getLinksFromHtml(html);
      expect(links).toHaveLength(0);
    });

    it('should handle HTML with no links', () => {
      const html = '<div><p>No links here</p></div>';
      const links = getLinksFromHtml(html);
      expect(links).toHaveLength(0);
    });

    it('should handle links with query parameters', () => {
      const html = `
        <div>
          <a href="https://example.com/file.pdf?version=1">Download</a>
        </div>
      `;

      const links = getLinksFromHtml(html);
      expect(links).toHaveLength(1);
      expect(links).toEqual(['https://example.com/file.pdf?version=1']);
    });
  });
});
