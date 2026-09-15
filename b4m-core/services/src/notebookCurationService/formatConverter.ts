import { marked } from 'marked';

export type ExportFormat = 'markdown' | 'txt' | 'html';

export interface ConversionResult {
  content: Buffer | string;
  mimeType: string;
  extension: string;
}

/**
 * Format Converter Service
 * Converts markdown content to various formats (txt, html)
 */
export class FormatConverter {
  constructor(private logger?: any) {}

  /**
   * Convert markdown content to specified format
   */
  async convert(markdownContent: string, format: ExportFormat): Promise<ConversionResult> {
    this.logger?.info(`Converting markdown to ${format}`);

    switch (format) {
      case 'markdown':
        return this.convertToMarkdown(markdownContent);
      case 'txt':
        return this.convertToTXT(markdownContent);
      case 'html':
        return this.convertToHTML(markdownContent);
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Markdown (no conversion needed)
   */
  private convertToMarkdown(content: string): ConversionResult {
    return {
      content: Buffer.from(content, 'utf-8'),
      mimeType: 'text/markdown',
      extension: '.md',
    };
  }

  /**
   * Convert markdown to HTML
   */
  private async convertToHTML(markdownContent: string): Promise<ConversionResult> {
    try {
      // Parse markdown to HTML
      const htmlBody = await marked.parse(markdownContent);

      // Wrap in complete HTML document
      const fullHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Curated Notebook</title>
    <style>
${this.getHTMLStylesheet()}
    </style>
</head>
<body>
    <div class="markdown-body">
${htmlBody}
    </div>
</body>
</html>`;

      return {
        content: Buffer.from(fullHTML, 'utf-8'),
        mimeType: 'text/html',
        extension: '.html',
      };
    } catch (error) {
      this.logger?.error('HTML conversion failed:', error);
      throw new Error(`HTML conversion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Convert markdown to plain text
   * Strips all markdown formatting and returns plain text
   */
  private convertToTXT(markdownContent: string): ConversionResult {
    // Remove markdown syntax to create plain text
    let plainText = markdownContent;

    // Remove headers (# ## ### etc)
    plainText = plainText.replace(/^#{1,6}\s+/gm, '');

    // Remove bold and italic (**text**, *text*, __text__, _text_)
    plainText = plainText.replace(/(\*\*|__)(.*?)\1/g, '$2');
    plainText = plainText.replace(/(\*|_)(.*?)\1/g, '$2');

    // Remove links [text](url) -> text
    plainText = plainText.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    // Remove images ![alt](url) -> [Image: alt]
    plainText = plainText.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[Image: $1]');

    // Remove inline code `code` -> code
    plainText = plainText.replace(/`([^`]+)`/g, '$1');

    // Remove code blocks ```language\ncode\n``` -> code
    plainText = plainText.replace(/```[\s\S]*?\n([\s\S]*?)```/g, '$1');

    // Remove horizontal rules (---, ***, ___)
    plainText = plainText.replace(/^[-*_]{3,}\s*$/gm, '');

    // Remove blockquote markers (> text)
    plainText = plainText.replace(/^>\s+/gm, '');

    // Remove HTML tags
    plainText = plainText.replace(/<[^>]+>/g, '');

    // Clean up multiple newlines
    plainText = plainText.replace(/\n{3,}/g, '\n\n');

    return {
      content: Buffer.from(plainText, 'utf-8'),
      mimeType: 'text/plain',
      extension: '.txt',
    };
  }

  /**
   * Get HTML-specific CSS stylesheet
   */
  private getHTMLStylesheet(): string {
    return `
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
        font-size: 16px;
        line-height: 1.6;
        color: #24292e;
        max-width: 980px;
        margin: 0 auto;
        padding: 45px;
        background-color: #fff;
      }
      .markdown-body {
        box-sizing: border-box;
        min-width: 200px;
        max-width: 980px;
      }
      h1, h2, h3, h4, h5, h6 {
        margin-top: 24px;
        margin-bottom: 16px;
        font-weight: 600;
        line-height: 1.25;
      }
      h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
      h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
      h3 { font-size: 1.25em; }
      pre {
        background-color: #f6f8fa;
        border-radius: 6px;
        padding: 16px;
        overflow: auto;
        font-size: 85%;
        line-height: 1.45;
      }
      code {
        background-color: rgba(27,31,35,0.05);
        border-radius: 3px;
        padding: 0.2em 0.4em;
        font-family: 'SF Mono', Monaco, Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace;
        font-size: 85%;
      }
      pre code {
        background-color: transparent;
        padding: 0;
        font-size: 100%;
      }
      blockquote {
        padding: 0 1em;
        color: #6a737d;
        border-left: 0.25em solid #dfe2e5;
        margin: 0 0 16px 0;
      }
      table {
        border-collapse: collapse;
        border-spacing: 0;
        width: 100%;
        margin-bottom: 16px;
        overflow: auto;
      }
      table th {
        font-weight: 600;
        background-color: #f6f8fa;
      }
      table th, table td {
        padding: 6px 13px;
        border: 1px solid #dfe2e5;
      }
      table tr {
        background-color: #fff;
        border-top: 1px solid #c6cbd1;
      }
      table tr:nth-child(2n) {
        background-color: #f6f8fa;
      }
      img {
        max-width: 100%;
        box-sizing: content-box;
        background-color: #fff;
      }
      a {
        color: #0366d6;
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      hr {
        height: 0.25em;
        padding: 0;
        margin: 24px 0;
        background-color: #e1e4e8;
        border: 0;
      }
    `;
  }
}
