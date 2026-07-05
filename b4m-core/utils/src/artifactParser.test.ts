import { describe, it, expect } from 'vitest';
import { convertCodeBlocksToArtifacts } from './artifactParser';
import { parseArtifacts } from './artifactParser';

/**
 * Regression coverage for the artifact parser hardening (gaps B & C):
 * bare <!DOCTYPE>/<html> documents and ```html fragments must be promoted to
 * artifacts so raw HTML never leaks into the chat, while content that is already
 * tagged or inside a generic code fence must be left untouched.
 */
describe('convertCodeBlocksToArtifacts — HTML promotion (#9259)', () => {
  const promote = (input: string) => {
    const converted = convertCodeBlocksToArtifacts(input);
    const { artifacts } = parseArtifacts(converted);
    return { converted, artifacts, wrappers: (converted.match(/<artifact /g) || []).length };
  };

  it('promotes a bare <!DOCTYPE html> document with no fence and no tag', () => {
    const { artifacts } = promote(
      'Here is your page:\n<!DOCTYPE html>\n<html><head><title>My Page</title></head><body><h1>Hi</h1></body></html>\nDone.'
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
    expect(artifacts[0].title).toBe('My Page');
  });

  it('promotes a bare <html>…</html> document without a doctype', () => {
    const { artifacts } = promote('<html><body><p>no doctype here</p></body></html>');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
  });

  it('promotes an HTML fragment inside a ```html fence (no full document)', () => {
    const { artifacts } = promote('Snippet:\n```html\n<div class="card"><p>hello</p></div>\n```\n');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
  });

  it('promotes a full document inside a ```html fence exactly once (no double-wrap)', () => {
    const { artifacts, wrappers } = promote(
      '```html\n<!DOCTYPE html>\n<html><head><title>Full</title></head><body>x</body></html>\n```'
    );
    expect(artifacts).toHaveLength(1);
    expect(wrappers).toBe(1);
  });

  it('does not re-wrap an HTML document already inside an <artifact> tag', () => {
    const { artifacts, wrappers } = promote(
      '<artifact identifier="x" type="text/html" title="T">\n<!DOCTYPE html>\n<html><body>z</body></html>\n</artifact>'
    );
    expect(artifacts).toHaveLength(1);
    expect(wrappers).toBe(1);
  });

  it('leaves an HTML document inside a generic ``` code fence as a code block', () => {
    const { artifacts, wrappers } = promote('```\n<!DOCTYPE html>\n<html><body>q</body></html>\n```');
    expect(artifacts).toHaveLength(0);
    expect(wrappers).toBe(0);
  });

  it('does not promote prose that merely mentions HTML', () => {
    const { artifacts } = promote('We were discussing how to structure a document in this chat.');
    expect(artifacts).toHaveLength(0);
  });
});
