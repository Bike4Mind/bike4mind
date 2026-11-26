import { describe, expect, it } from 'vitest';
import { truncateToSchemaCap } from './bounds';
import {
  MAX_MARKDOWN_PARSE_CHARS,
  normalizePublicText,
  parseMarkdown,
  renderMarkdownHtml,
  renderMarkdownText,
  sanitizeMarkdown,
  serializeMarkdown,
  truncateMarkdown,
} from './markdown';

const options = { linkHosts: ['app.example.com'], supportEmail: 'help@example.com' };
const html = (source: string) => renderMarkdownHtml(parseMarkdown(source, options));

describe('allowed syntax', () => {
  it('renders paragraphs, line breaks, bold, italic and inline code', () => {
    expect(html('one **bold** and *italic* and `code`\nnext line\n\nsecond')).toBe(
      '<p>one <strong>bold</strong> and <em>italic</em> and <code>code</code><br />next line</p><p>second</p>'
    );
  });

  it('renders unordered and ordered lists', () => {
    expect(html('- a\n- b **x**')).toBe('<ul><li>a</li><li>b <strong>x</strong></li></ul>');
    expect(html('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('does not treat emphasis markers or snake_case as a list or italics', () => {
    expect(html('*not a list*')).toBe('<p><em>not a list</em></p>');
    expect(html('use snake_case_name here')).toBe('<p>use snake_case_name here</p>');
    expect(html('2 * 3 * 4')).toBe('<p>2 * 3 * 4</p>');
  });

  it('keeps unmatched syntax as literal text', () => {
    expect(html('**open and `tick and [label](')).toBe('<p>**open and `tick and [label](</p>');
  });

  it('plain text renderer shows the host of a link', () => {
    const blocks = parseMarkdown('see [the app](https://app.example.com/x)\n\n- one', options);
    expect(renderMarkdownText(blocks)).toBe('see the app (app.example.com)\n\n- one');
  });
});

describe('escaping and raw HTML', () => {
  it('renders raw HTML as text', () => {
    expect(html('<script>alert(1)</script> <b>x</b>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;b&gt;x&lt;/b&gt;</p>'
    );
    expect(html('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('escapes quotes and ampersands everywhere', () => {
    expect(html('a & b "q" \'s\'')).toBe('<p>a &amp; b &quot;q&quot; &#39;s&#39;</p>');
    expect(html('`<x>&`')).toBe('<p><code>&lt;x&gt;&amp;</code></p>');
    expect(html('<>&"\'')).toBe('<p>&lt;&gt;&amp;&quot;&#39;</p>');
  });

  it('keeps headings and images as literal text', () => {
    expect(html('# heading')).toBe('<p># heading</p>');
    expect(html('![alt](https://app.example.com/x.png)')).toBe('<p>![alt](https://app.example.com/x.png)</p>');
  });

  it('honours backslash escapes', () => {
    expect(html('\\*not bold\\* \\[x\\](https://app.example.com)')).toBe(
      '<p>*not bold* [x](https://app.example.com)</p>'
    );
  });
});

describe('links', () => {
  it('links allowlisted https hosts with a safe rel and the host shown', () => {
    expect(html('[docs](https://app.example.com/a)')).toBe(
      '<p><a href="https://app.example.com/a" rel="noopener noreferrer nofollow">docs</a> (app.example.com)</p>'
    );
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](JAVASCRIPT:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](vbscript:msgbox(1))',
    '[x](http://app.example.com/)',
    '[x](https://evil.example.net/)',
    '[x](//evil.example.net/)',
    '[x](https://user:pw@app.example.com/)',
    '[x](mailto:other@example.com)',
  ])('renders %s as plain text without an anchor', source => {
    const rendered = html(source);
    expect(rendered).not.toContain('<a');
    expect(rendered).not.toContain('href');
    expect(rendered).toBe('<p>x</p>');
  });

  it('allows mailto only to the support address', () => {
    expect(html('[mail](mailto:help@example.com)')).toContain('<a href="mailto:help@example.com"');
  });

  it('does not nest links', () => {
    expect(html('[a [b](https://app.example.com/b)](https://app.example.com/a)')).not.toContain(
      '<a href="https://app.example.com/a"'
    );
  });
});

describe('normalization', () => {
  it('strips bidi controls, zero-width characters and C0/C1 controls but keeps newlines', () => {
    const dirty = 'a\u202eb\u2066c\u2069d\u200be\u200ff\ufeffg\u0000h\u0007i\u0085j\u009fk\tl\nm';
    expect(normalizePublicText(dirty)).toBe('abcdefghijkl\nm');
  });

  it('normalizes to NFC and line endings to newline', () => {
    expect(normalizePublicText('e\u0301')).toBe('\u00e9');
    expect(normalizePublicText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips hidden characters before parsing, so they cannot hide a scheme', () => {
    expect(html('[x](java\u200bscript:alert(1))')).toBe('<p>x</p>');
    expect(html('[x](https://app.example.com/\u202e)')).toContain('href="https://app.example.com/"');
  });
});

describe('round trip', () => {
  const samples = [
    'plain text',
    'a *b* **c** `d`',
    '- one\n- two\n\npara',
    '1. a\n2. b',
    'line one\nline two',
    '- tricky \\- start\n\n\\- escaped start',
    '1\\. not a list',
    'see [docs](https://app.example.com/a_(b)) now',
    '<b>x</b> \\* \\_ \\[ \\] \\`',
    '[x](https://evil.example.net/) stays text',
  ];

  it.each(samples)('serialize(parse(x)) is stable for %j', sample => {
    const once = sanitizeMarkdown(sample, options);
    expect(sanitizeMarkdown(once, options)).toBe(once);
    expect(parseMarkdown(once, options)).toEqual(parseMarkdown(sample, options));
  });

  it('serializes a stripped link to its label only', () => {
    expect(sanitizeMarkdown('[click](https://evil.example.net/)', options)).toBe('click');
  });

  it('serializes blocks back to text', () => {
    expect(serializeMarkdown(parseMarkdown('a\n\n- b', options))).toBe('a\n\n- b');
  });
});

describe('caps', () => {
  it('truncates to the code point cap with an ellipsis', () => {
    expect(truncateMarkdown('short', 10)).toEqual({ text: 'short', truncated: false });
    const cut = truncateMarkdown('x'.repeat(50), 10);
    expect(cut.truncated).toBe(true);
    expect(Array.from(cut.text)).toHaveLength(10);
    expect(cut.text.endsWith('\u2026')).toBe(true);
  });

  it('does not split a surrogate pair', () => {
    const cut = truncateMarkdown('\u{1F600}'.repeat(20), 5);
    expect(Array.from(cut.text)).toHaveLength(5);
    expect(cut.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('bounds parsing input and nesting depth', () => {
    const huge = 'a'.repeat(MAX_MARKDOWN_PARSE_CHARS + 5_000);
    const blocks = parseMarkdown(huge, options);
    expect(
      blocks[0].type === 'paragraph' && blocks[0].children[0].type === 'text' && blocks[0].children[0].value.length
    ).toBe(MAX_MARKDOWN_PARSE_CHARS);
    expect(() => parseMarkdown('*'.repeat(5_000) + '**'.repeat(5_000), options)).not.toThrow();
    expect(() => parseMarkdown('['.repeat(3_000) + ']('.repeat(3_000), options)).not.toThrow();
  });
});

describe('sanitizing is a fixed point that renders the same page', () => {
  const cases = [
    '_a **b** c_',
    '**a _b_ c**',
    '**_a_**',
    '_**a**_',
    '***a***',
    '*a **b** c*',
    '_a *b* c_',
    '*a _b_ c*',
    'x*a*y and _b_',
    '**a `*` b** and *`c`*',
    '_[ok](https://app.example.com/x) **y**_',
    '_a_[gone](https://evil.example.net/p)',
    '**[gone](https://evil.example.net/p)_a_**',
    '- _a **b**_\n- **_c_** d',
    '1. *x* `y_z` [l](https://app.example.com)',
    'a\\_b \\*c\\* `d`\n\ne _f_',
    '\\![img](https://app.example.com/a.png)',
    '[ ](https://evil.example.net/p)\n_x_',
  ];

  it.each(cases)('%j', source => {
    const once = sanitizeMarkdown(source, options);
    expect(sanitizeMarkdown(once, options)).toBe(once);
    expect(html(once)).toBe(html(source));
  });

  it('keeps the nested emphasis the author wrote', () => {
    expect(sanitizeMarkdown('_a **b** c_', options)).toBe('_a **b** c_');
    expect(html('_a **b** c_')).toBe('<p><em>a <strong>b</strong> c</em></p>');
  });
});

describe('truncation never cuts inside a markdown token', () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const visibleText = (value: string) => html(value).replace(/<[^>]*>/g, '');
  const constructs = [
    ['link label', '[status page](https://app.example.com/x)', 4],
    ['link url', '[status page](https://app.example.com/x)', 22],
    ['link bracket', '[status page](https://app.example.com/x)', 12],
    ['strong', '**bold text**', 6],
    ['em with underscores', '_em text_', 4],
    ['em with asterisks', '*em text*', 4],
    ['code span', '`code span`', 5],
    ['after a backslash escape', '\\*star and more', 1],
    ['emoji', '\u{1F600}\u{1F600}\u{1F600}', 1],
  ] as const;
  const cases = constructs.flatMap(([name, construct, offset]) =>
    ([1_000, 4_000] as const).map(max => [name, construct, offset, max] as const)
  );

  it.each(cases)('%s at the %i cap', (_name, construct, offset, max) => {
    const body = sanitizeMarkdown(`${'a'.repeat(max - 2 - offset)} ${construct} and a tail`, options);
    const { text, truncated } = truncateToSchemaCap(body, max);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(max);
    expect(Array.from(text).length).toBeLessThanOrEqual(max);
    expect(text.endsWith('\u2026')).toBe(true);
    expect(text).not.toMatch(LONE_SURROGATE);
    expect(sanitizeMarkdown(text, options)).toBe(text);
    expect(visibleText(text)).not.toMatch(/\[|\]\(|\*|_|`/);
  });

  it('cuts inside a token that holds escapes by UTF-16 units too', () => {
    const body = sanitizeMarkdown(`${'a'.repeat(995)} **${'\u{1F600}'.repeat(10)}** tail`, options);
    const { text } = truncateToSchemaCap(body, 1_000);
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).not.toMatch(LONE_SURROGATE);
    expect(visibleText(text)).not.toMatch(/\*/);
  });

  it.each([
    ['strong', '**', '**'],
    ['em', '_', '_'],
    ['code', '`', '`'],
    ['a list item in strong', '- first\n- **', '**'],
    ['strong inside em', '_lead **', '**_'],
  ])('keeps the text of a long %s that is cut, and closes it', (_name, opener, closer) => {
    const body = sanitizeMarkdown(`${opener}${'word '.repeat(400).trim()}${closer}`, options);
    const { text, truncated } = truncateToSchemaCap(body, 1_000);
    expect(truncated).toBe(true);
    expect(text.length).toBeGreaterThan(900);
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text.endsWith(`${body.slice(-closer.length)}\u2026`)).toBe(true);
    expect(visibleText(body).startsWith(visibleText(text).slice(0, -1))).toBe(true);
    expect(sanitizeMarkdown(text, options)).toBe(text);
    expect(visibleText(text)).not.toMatch(/\[|\]\(|\*|_|`/);
  });

  it('drops an emphasis opener that has no text before the cut', () => {
    const body = sanitizeMarkdown(`${'a'.repeat(997)} **bold tail**`, options);
    const { text } = truncateToSchemaCap(body, 1_000);
    expect(text).toBe(`${'a'.repeat(997)}\u2026`);
  });

  it('keeps closed tokens before the cut', () => {
    const body = sanitizeMarkdown(`**kept** [link](https://app.example.com/x) ${'a'.repeat(50)} **cut here`, options);
    const { text } = truncateMarkdown(body, 80);
    expect(text.startsWith('**kept** [link](https://app.example.com/x) aaa')).toBe(true);
    expect(text.endsWith('a\u2026')).toBe(true);
  });

  it.each(['[a]('.repeat(5_000), '**a'.repeat(6_000), '`a'.repeat(10_000), '\\'.repeat(20_000)])(
    'stays fast on adversarial input %#',
    input => {
      const started = performance.now();
      const result = truncateToSchemaCap(input, 1_000);
      expect(performance.now() - started).toBeLessThan(250);
      expect(result.text.length).toBeLessThanOrEqual(1_000);
    }
  );
});
