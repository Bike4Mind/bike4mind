import { describe, it, expect } from 'vitest';
import { stripFabricatedLinks, isFabricatedDocLink } from './sanitizeHelpLinks';

describe('isFabricatedDocLink', () => {
  it('flags app-domain URLs as fabricated', () => {
    expect(isFabricatedDocLink('https://app.staging.bike4mind.com/ai-models.md')).toBe(true);
    expect(isFabricatedDocLink('https://app.bike4mind.com/new?help=features%2Fai-models')).toBe(true);
  });

  it('flags relative paths and bare anchors', () => {
    expect(isFabricatedDocLink('./ai-models.md')).toBe(true);
    expect(isFabricatedDocLink('/features/ai-models')).toBe(true);
    expect(isFabricatedDocLink('#search-capabilities')).toBe(true);
  });

  it('flags unsafe schemes', () => {
    expect(isFabricatedDocLink('javascript:alert(1)')).toBe(true);
    expect(isFabricatedDocLink('data:text/html,<script>alert(1)</script>')).toBe(true);
  });

  it('treats mailto:/tel: as legitimate contact links', () => {
    expect(isFabricatedDocLink('mailto:support@bike4mind.com')).toBe(false);
    expect(isFabricatedDocLink('tel:+18005551234')).toBe(false);
  });

  it('flags any markdown-file link regardless of host', () => {
    expect(isFabricatedDocLink('https://example.com/docs/ai-models.md')).toBe(true);
    expect(isFabricatedDocLink('https://example.com/ai-models.md?x=1')).toBe(true);
    // a trailing slash after the .md extension is still a guessed doc path
    expect(isFabricatedDocLink('https://example.com/ai-models.md/')).toBe(true);
  });

  it('leaves genuine external links intact', () => {
    expect(isFabricatedDocLink('https://openai.com/pricing')).toBe(false);
    expect(isFabricatedDocLink('https://docs.anthropic.com/en/api')).toBe(false);
  });

  it('only matches the hostname/pathname, not substrings in query/fragment', () => {
    // bike4mind.com / .md appearing in a query string must NOT flag a real external link
    expect(isFabricatedDocLink('https://openai.com/?ref=https://app.bike4mind.com')).toBe(false);
    expect(isFabricatedDocLink('https://openai.com/search?q=ai-models.md')).toBe(false);
    // a ".md" mid-path (not the file extension) is a real path, not a doc hallucination
    expect(isFabricatedDocLink('https://example.com/path.md.html')).toBe(false);
  });
});

describe('stripFabricatedLinks', () => {
  it('collapses a fabricated app-domain doc link to its label (the reported bug)', () => {
    const input = 'Check out [AI Models](https://app.staging.bike4mind.com/ai-models.md) for details.';
    expect(stripFabricatedLinks(input)).toBe('Check out AI Models for details.');
  });

  it('collapses relative and .md links to plain text', () => {
    expect(stripFabricatedLinks('See [AI Models](./ai-models.md).')).toBe('See AI Models.');
    expect(stripFabricatedLinks('See [Notebooks](/features/notebooks).')).toBe('See Notebooks.');
  });

  it('collapses fabricated image-style links to alt text with no stray "!"', () => {
    expect(stripFabricatedLinks('![AI Models](https://app.bike4mind.com/ai-models.md)')).toBe('AI Models');
  });

  it('strips a fabricated bare URL, preserving trailing sentence punctuation', () => {
    expect(stripFabricatedLinks('See https://app.staging.bike4mind.com/ai-models.md.')).toBe('See.');
    expect(stripFabricatedLinks('Open https://app.bike4mind.com/ai-models.md to learn more')).toBe(
      'Open to learn more'
    );
  });

  it('strips a fabricated CommonMark autolink, leaving no orphaned brackets', () => {
    expect(stripFabricatedLinks('See <https://app.bike4mind.com/ai-models.md> for details.')).toBe('See for details.');
  });

  it('preserves genuine external links (markdown, bare, and autolink)', () => {
    const md = 'See [OpenAI pricing](https://openai.com/pricing) for rates.';
    expect(stripFabricatedLinks(md)).toBe(md);
    const bare = 'See https://openai.com/pricing for rates.';
    expect(stripFabricatedLinks(bare)).toBe(bare);
    const autolink = 'See <https://openai.com/pricing> for rates.';
    expect(stripFabricatedLinks(autolink)).toBe(autolink);
  });

  it('preserves genuine external image links', () => {
    const input = '![diagram](https://example.com/diagram.png)';
    expect(stripFabricatedLinks(input)).toBe(input);
  });

  it('handles multiple links in one response', () => {
    const input =
      'Use [AI Models](https://app.bike4mind.com/ai-models.md) and [the API](https://docs.example.com/api).';
    expect(stripFabricatedLinks(input)).toBe('Use AI Models and [the API](https://docs.example.com/api).');
  });

  it('collapses a fabricated link whose URL contains parentheses, leaving no fragment', () => {
    const input = 'See [the doc](https://app.bike4mind.com/doc_(v2).md) here.';
    expect(stripFabricatedLinks(input)).toBe('See the doc here.');
  });

  it('collapses a fabricated link written with a markdown title', () => {
    const input = 'See [AI Models](https://app.bike4mind.com/ai-models.md "AI Models docs") here.';
    expect(stripFabricatedLinks(input)).toBe('See AI Models here.');
  });

  it('collapses a fabricated link with angle-bracket-wrapped URL', () => {
    const input = 'See [AI Models](<https://app.bike4mind.com/ai-models.md>) here.';
    expect(stripFabricatedLinks(input)).toBe('See AI Models here.');
  });

  it('preserves an external link written with a markdown title', () => {
    const input = 'See [pricing](https://openai.com/pricing "OpenAI pricing") for rates.';
    expect(stripFabricatedLinks(input)).toBe(input);
  });

  it('preserves an external markdown link whose query mentions the app domain', () => {
    const input = 'See [pricing](https://openai.com/?ref=https://app.bike4mind.com) for rates.';
    expect(stripFabricatedLinks(input)).toBe(input);
  });

  it('strips an unsafe-scheme markdown link to its label', () => {
    expect(stripFabricatedLinks('Click [here](javascript:alert(1)) now.')).toBe('Click here now.');
  });

  it('preserves legitimate mailto/tel contact links the assistant is told to suggest', () => {
    const md = 'Contact [support](mailto:support@bike4mind.com) for help.';
    expect(stripFabricatedLinks(md)).toBe(md);
    const bare = 'Email support@bike4mind.com or call tel:+18005551234 for help.';
    expect(stripFabricatedLinks(bare)).toBe(bare);
  });

  it('leaves link-free text untouched', () => {
    const input = 'Open any **Notebook**, then use the model selector dropdown.';
    expect(stripFabricatedLinks(input)).toBe(input);
  });
});
