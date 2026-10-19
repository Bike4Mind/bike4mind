import type { ChatMessage } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { extractArtifacts, restoreArtifactMarkup } from './extract';

function reply(content: string): ChatMessage {
  const parsed = extractArtifacts(content);
  return {
    id: 'm1',
    role: 'assistant',
    content: parsed.content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(parsed.artifacts.length > 0 ? { artifacts: parsed.artifacts } : {}),
  };
}

describe('extractArtifacts', () => {
  it('leaves a reply with no artifact exactly as it was', () => {
    const content = 'Here is how you would do it, in about four lines of shell.';
    expect(extractArtifacts(content)).toEqual({ content, artifacts: [] });
  });

  it('does not mistake prose about artifacts for one', () => {
    const content = 'An <artifact> tag needs a closing tag, and this sentence has none.';
    expect(extractArtifacts(content).artifacts).toEqual([]);
  });

  it('lifts one artifact out and leaves the prose around it', () => {
    const { content, artifacts } = extractArtifacts(
      'Sure - here it is.\n' +
        '<artifact identifier="hello" type="text/html" title="Hello Page"><h1>Hi</h1></artifact>\n' +
        'Tell me if you want it darker.'
    );

    expect(content).toBe('Sure - here it is.\n\nTell me if you want it darker.');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      identifier: 'hello',
      type: 'html',
      mimeType: 'text/html',
      title: 'Hello Page',
      content: '<h1>Hi</h1>',
    });
    expect(artifacts[0].id).toEqual(expect.any(String));
  });

  it('lifts several artifacts of different types out of one reply', () => {
    const { content, artifacts } = extractArtifacts(
      'Two things.\n' +
        '<artifact identifier="a" type="image/svg+xml" title="Mark"><svg><circle r="1"/></svg></artifact>\n' +
        '<artifact identifier="b" type="application/vnd.ant.python" title="Loader">import csv</artifact>'
    );

    expect(content).toBe('Two things.');
    expect(artifacts.map(a => [a.type, a.title])).toEqual([
      ['svg', 'Mark'],
      ['python', 'Loader'],
    ]);
  });

  it('keeps the type attribute the model wrote, not a canonical spelling of it', () => {
    // mapMimeTypeToArtifactType folds several spellings onto one ArtifactType, so restoring the
    // markup from that alone would rewrite the model's own tag.
    const { artifacts } = extractArtifacts('<artifact type="html" title="T">x</artifact>');
    expect(artifacts[0]).toMatchObject({ type: 'html', mimeType: 'html' });
  });

  it('keeps an artifact with no identifier, which the model need not supply', () => {
    const { artifacts } = extractArtifacts('<artifact type="text/html" title="T"><p>x</p></artifact>');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].identifier).toBeUndefined();
  });
});

describe('restoreArtifactMarkup', () => {
  it('returns a message with no artifacts unchanged', () => {
    expect(restoreArtifactMarkup(reply('just prose'))).toBe('just prose');
  });

  it('round-trips through a second parse with the body intact', () => {
    const body = '<h1>Hi</h1>\n<script>console.log(1)</script>';
    const original = `Here.\n<artifact identifier="hello" type="text/html" title="Hello">${body}</artifact>`;

    const restored = restoreArtifactMarkup(reply(original));
    const reparsed = extractArtifacts(restored);

    expect(reparsed.content).toBe('Here.');
    expect(reparsed.artifacts[0]).toMatchObject({
      identifier: 'hello',
      mimeType: 'text/html',
      title: 'Hello',
      content: body,
    });
  });

  it('restores every artifact of a multi-artifact turn', () => {
    const restored = restoreArtifactMarkup(
      reply(
        '<artifact identifier="a" type="text/html" title="A">one</artifact>' +
          '<artifact identifier="b" type="text/html" title="B">two</artifact>'
      )
    );

    expect(extractArtifacts(restored).artifacts.map(a => a.content)).toEqual(['one', 'two']);
  });

  it('survives a title containing a quote rather than emitting unparseable markup', () => {
    // The shared attribute matcher anchors a value to its own quote kind and has no escape, so a
    // double quote left in a title would end the attribute early and corrupt the rest of the tag.
    const restored = restoreArtifactMarkup(reply("<artifact type='text/html' title='The \"Big\" One'>x</artifact>"));
    const reparsed = extractArtifacts(restored);

    expect(reparsed.artifacts).toHaveLength(1);
    expect(reparsed.artifacts[0].content).toBe('x');
  });
});
