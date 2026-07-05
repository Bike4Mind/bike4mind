import { describe, it, expect } from 'vitest';
import { ClaudeArtifactMimeTypes } from '@bike4mind/common';
import { sanitizeJsonString, parseTransformationResult, wrapDraftAsArtifact } from './index';

// Mirror the production artifact-parsing regexes (sharedToolBuilder.ts / client artifactParser.ts)
const ARTIFACT_RE = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/i;
const ATTR_RE = /(\w+)=["']([^"']*?)["']/g;

function parseArtifact(tagged: string) {
  const m = ARTIFACT_RE.exec(tagged);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  let a: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((a = ATTR_RE.exec(m[1])) !== null) attrs[a[1]] = a[2];
  return { attrs, body: m[2].trim() };
}

describe('blogDraft', () => {
  describe('sanitizeJsonString', () => {
    it('should not modify valid JSON with escaped control characters', () => {
      const validJson = '{"title": "Hello\\nWorld", "content": "Line1\\nLine2\\tTabbed"}';
      expect(sanitizeJsonString(validJson)).toBe(validJson);
    });

    it('should escape literal newlines inside string values', () => {
      const input = '{"title": "Hello\nWorld"}';
      const expected = '{"title": "Hello\\nWorld"}';
      expect(sanitizeJsonString(input)).toBe(expected);
    });

    it('should escape literal carriage returns inside string values', () => {
      const input = '{"title": "Hello\rWorld"}';
      const expected = '{"title": "Hello\\rWorld"}';
      expect(sanitizeJsonString(input)).toBe(expected);
    });

    it('should escape literal tabs inside string values', () => {
      const input = '{"title": "Hello\tWorld"}';
      const expected = '{"title": "Hello\\tWorld"}';
      expect(sanitizeJsonString(input)).toBe(expected);
    });

    it('should handle Windows-style CRLF line endings', () => {
      const input = '{"content": "Line1\r\nLine2"}';
      const expected = '{"content": "Line1\\r\\nLine2"}';
      expect(sanitizeJsonString(input)).toBe(expected);
    });

    it('should preserve newlines outside of strings (JSON structure)', () => {
      const input = `{
  "title": "Test",
  "content": "Value"
}`;
      // Newlines outside strings should be preserved as-is
      const result = sanitizeJsonString(input);
      expect(result).toContain('\n');
      expect(JSON.parse(result)).toEqual({ title: 'Test', content: 'Value' });
    });

    it('should handle mixed escaped and unescaped newlines', () => {
      const input = '{"title": "Already\\nescaped", "content": "Not\nescaped"}';
      const expected = '{"title": "Already\\nescaped", "content": "Not\\nescaped"}';
      expect(sanitizeJsonString(input)).toBe(expected);
    });

    it('should handle escaped quotes inside strings', () => {
      const input = '{"title": "He said \\"Hello\\"", "content": "Line1\nLine2"}';
      const expected = '{"title": "He said \\"Hello\\"", "content": "Line1\\nLine2"}';
      expect(sanitizeJsonString(input)).toBe(expected);
    });

    it('should handle multiple control characters in one string', () => {
      const input = '{"content": "Line1\nLine2\tTabbed\rReturn"}';
      const expected = '{"content": "Line1\\nLine2\\tTabbed\\rReturn"}';
      expect(sanitizeJsonString(input)).toBe(expected);
    });

    it('should handle empty strings', () => {
      const input = '{"title": "", "content": ""}';
      expect(sanitizeJsonString(input)).toBe(input);
    });

    it('should handle complex nested JSON', () => {
      const input = '{"title": "Test", "tags": ["tag1", "tag\n2"], "content": "Hello\nWorld"}';
      const expected = '{"title": "Test", "tags": ["tag1", "tag\\n2"], "content": "Hello\\nWorld"}';
      expect(sanitizeJsonString(input)).toBe(expected);
    });

    it('should handle backslash followed by non-escape character', () => {
      const input = '{"path": "C:\\\\Users\\\\test", "content": "Hello\nWorld"}';
      const result = sanitizeJsonString(input);
      // Should preserve the escaped backslashes and escape the newline
      expect(result).toBe('{"path": "C:\\\\Users\\\\test", "content": "Hello\\nWorld"}');
    });
  });

  describe('parseTransformationResult', () => {
    it('should parse valid JSON in markdown code block', () => {
      const response = `Here is your blog post:

\`\`\`json
{
  "title": "My Blog Post",
  "content": "# Introduction\\n\\nThis is the content.",
  "summary": "A brief summary",
  "suggestedTags": ["tech", "blog"]
}
\`\`\`

Done!`;

      const result = parseTransformationResult(response);
      expect(result.title).toBe('My Blog Post');
      expect(result.content).toBe('# Introduction\n\nThis is the content.');
      expect(result.summary).toBe('A brief summary');
      expect(result.suggestedTags).toEqual(['tech', 'blog']);
    });

    it('should parse JSON with literal newlines in content', () => {
      // Simulate LLM returning JSON with actual newlines instead of escaped
      const response = `\`\`\`json
{
  "title": "Test Post",
  "content": "Line 1
Line 2
Line 3",
  "summary": "Summary",
  "suggestedTags": []
}
\`\`\``;

      const result = parseTransformationResult(response);
      expect(result.title).toBe('Test Post');
      expect(result.content).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should parse JSON with literal tabs in content', () => {
      const response = `\`\`\`json
{
  "title": "Code Post",
  "content": "function test() {\n\treturn true;\n}",
  "summary": "Code example",
  "suggestedTags": ["code"]
}
\`\`\``;

      const result = parseTransformationResult(response);
      expect(result.content).toContain('\t');
    });

    it('should handle raw JSON without code blocks', () => {
      const response = `{"title": "Direct JSON", "content": "Hello World", "summary": "Test", "suggestedTags": []}`;

      const result = parseTransformationResult(response);
      expect(result.title).toBe('Direct JSON');
    });

    it('should throw error for missing title', () => {
      const response = '{"content": "No title", "summary": "Test"}';
      expect(() => parseTransformationResult(response)).toThrow('Failed to parse transformation result');
    });

    it('should throw error for missing content', () => {
      const response = '{"title": "No content", "summary": "Test"}';
      expect(() => parseTransformationResult(response)).toThrow('Failed to parse transformation result');
    });

    it('should default summary to empty string if missing', () => {
      const response = '{"title": "Test", "content": "Content"}';
      const result = parseTransformationResult(response);
      expect(result.summary).toBe('');
    });

    it('should default suggestedTags to empty array if missing', () => {
      const response = '{"title": "Test", "content": "Content"}';
      const result = parseTransformationResult(response);
      expect(result.suggestedTags).toEqual([]);
    });

    it('should handle generic code block without json specifier', () => {
      const response = `\`\`\`
{
  "title": "Generic Block",
  "content": "Test content",
  "summary": "Test",
  "suggestedTags": []
}
\`\`\``;

      const result = parseTransformationResult(response);
      expect(result.title).toBe('Generic Block');
    });

    it('should throw descriptive error for empty response', () => {
      expect(() => parseTransformationResult('')).toThrow('LLM returned an empty response');
    });

    it('should throw descriptive error for whitespace-only response', () => {
      expect(() => parseTransformationResult('   \n\t  ')).toThrow('LLM returned an empty response');
    });

    it('should throw descriptive error for code block with empty content', () => {
      const response = '```json\n```';
      // The paired regex won't match (no content between delimiters); the tolerant
      // fence stripping reduces this to an empty string, which is correctly
      // reported as a non-extractable response.
      expect(() => parseTransformationResult(response)).toThrow('Could not extract valid JSON');
    });

    // Production hit `SyntaxError: Unexpected token '`'` because the paired
    // fence regex requires a closing ``` preceded by a newline. When the model
    // attaches the closing fence directly after the JSON (no preceding newline),
    // the regex fails entirely and the raw "```json..." string reaches JSON.parse.
    it('should parse fenced JSON whose closing fence has no preceding newline (#9197)', () => {
      const response = '```json\n  {\n    "title": "Fenced",\n    "content": "Body"\n  }```';
      const result = parseTransformationResult(response);
      expect(result.title).toBe('Fenced');
      expect(result.content).toBe('Body');
    });

    // A model may open with ```json and omit the closing fence (e.g. a
    // long response). The leading fence must still be stripped so the embedded
    // JSON object parses rather than throwing on the backtick.
    it('should parse fenced JSON with no closing fence at all (#9197)', () => {
      const response = '```json\n{\n  "title": "Unclosed",\n  "content": "Still valid JSON"\n}';
      const result = parseTransformationResult(response);
      expect(result.title).toBe('Unclosed');
      expect(result.content).toBe('Still valid JSON');
    });
  });

  describe('wrapDraftAsArtifact', () => {
    const baseResult = {
      title: 'My Blog Post',
      content: '# Intro\n\nBody text.',
      summary: 'A summary',
      suggestedTags: ['tech', 'blog'],
    };

    it('wraps the draft in an <artifact> tag with the blog-draft MIME type', () => {
      const out = wrapDraftAsArtifact(baseResult, 'blog-draft-123');
      const parsed = parseArtifact(out);
      expect(parsed).not.toBeNull();
      expect(parsed!.attrs.type).toBe(ClaudeArtifactMimeTypes.BLOG_DRAFT);
      expect(parsed!.attrs.identifier).toBe('blog-draft-123');
      expect(parsed!.attrs.title).toBe('My Blog Post');
    });

    it('round-trips the JSON body losslessly via JSON.parse', () => {
      const out = wrapDraftAsArtifact(baseResult, 'blog-draft-1');
      const parsed = parseArtifact(out)!;
      expect(JSON.parse(parsed.body)).toEqual(baseResult);
    });

    it('sanitizes parse-breaking chars in the title attribute (readable, not entity-encoded)', () => {
      const out = wrapDraftAsArtifact({ ...baseResult, title: 'A & B <C> "D"' }, 'id');
      const parsed = parseArtifact(out)!;
      // Attribute extraction must still succeed and recover the type...
      expect(parsed.attrs.type).toBe(ClaudeArtifactMimeTypes.BLOG_DRAFT);
      // ...and the title stays human-readable: < > stripped, straight quotes -> curly,
      // & kept verbatim (no "&amp;"/"&lt;" gibberish in metadata.title).
      expect(parsed.attrs.title).toBe('A & B C ”D”');
    });

    it('keeps a title with an apostrophe intact (no truncation at the quote)', () => {
      // Real-world: "Why You Can't Tax Attention". A straight ' would terminate the
      // [^"'] value matcher and truncate metadata.title to "Why You Can".
      const out = wrapDraftAsArtifact({ ...baseResult, title: "Why You Can't Tax Attention" }, 'id');
      const parsed = parseArtifact(out)!;
      expect(parsed.attrs.type).toBe(ClaudeArtifactMimeTypes.BLOG_DRAFT);
      expect(parsed.attrs.title).toBe('Why You Can’t Tax Attention');
    });

    it('normalizes newlines/tabs in the title so the single-line attribute regex is not broken', () => {
      const out = wrapDraftAsArtifact({ ...baseResult, title: 'Line one\nLine\ttwo' }, 'id');
      const parsed = parseArtifact(out);
      // Must still parse (a raw newline in the attr would make the .*? matcher fail)
      expect(parsed).not.toBeNull();
      expect(parsed!.attrs.type).toBe(ClaudeArtifactMimeTypes.BLOG_DRAFT);
      expect(parsed!.attrs.title).toBe('Line one Line two');
    });

    it('uses a unique identifier per call (no Date.now collision)', () => {
      // The tool passes `blog-draft-${randomUUID()}`; here we assert the helper faithfully
      // emits whatever identifier it is given (uniqueness is the caller's contract).
      const a = wrapDraftAsArtifact(baseResult, 'blog-draft-aaa');
      const b = wrapDraftAsArtifact(baseResult, 'blog-draft-bbb');
      expect(parseArtifact(a)!.attrs.identifier).toBe('blog-draft-aaa');
      expect(parseArtifact(b)!.attrs.identifier).toBe('blog-draft-bbb');
    });

    it('survives blog prose containing a literal </artifact> sequence', () => {
      const tricky = {
        ...baseResult,
        content: 'To close an artifact you write </artifact> and also </div> tags.',
      };
      const out = wrapDraftAsArtifact(tricky, 'id');
      // The escaped body must not contain a literal closing delimiter that would truncate it
      const parsed = parseArtifact(out)!;
      // Body extracted to the FIRST real </artifact> must still be the complete JSON
      expect(JSON.parse(parsed.body)).toEqual(tricky);
      expect(JSON.parse(parsed.body).content).toContain('</artifact>');
    });
  });
});
