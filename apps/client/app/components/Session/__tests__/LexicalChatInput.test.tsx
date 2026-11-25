import { describe, it, expect } from 'vitest';
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { $convertToMarkdownString } from '@lexical/markdown';
import { CodeNode, CodeHighlightNode } from '@lexical/code-core';
import { ListNode, ListItemNode } from '@lexical/list';
import { BeautifulMentionNode, $createBeautifulMentionNode } from 'lexical-beautiful-mentions';
import { CHAT_MARKDOWN_TRANSFORMERS, $hasInlineFormatting } from '../LexicalChatInput';

// Markdown round-trip serialization.
//
// These exercise the pure serialization logic behind `getSerializedValue()`
// against a headless Lexical editor. We drive the editor state directly rather
// than through `userEvent.keyboard()` because the latter doesn't trigger
// Lexical's onChange under jsdom, which would
// otherwise make these tests flaky/no-ops.
describe('LexicalChatInput - markdown round-trip serialization', () => {
  const makeEditor = () =>
    createEditor({
      nodes: [CodeNode, CodeHighlightNode, ListNode, ListItemNode, BeautifulMentionNode],
      onError: (error: Error) => {
        throw error;
      },
    });

  // Build editor state synchronously, then run `read` inside an editor read so
  // the `$`-prefixed helpers have an active editor. Mirrors getSerializedValue().
  const withEditor = <T,>(build: () => void, read: () => T): T => {
    const editor = makeEditor();
    editor.update(build, { discrete: true });
    let result!: T;
    editor.getEditorState().read(() => {
      result = read();
    });
    return result;
  };

  const setParagraph = (build: (paragraph: ReturnType<typeof $createParagraphNode>) => void) => {
    const paragraph = $createParagraphNode();
    build(paragraph);
    $getRoot().clear().append(paragraph);
  };

  // What the send path actually emits: markdown iff the message has inline
  // formatting, otherwise plain text unchanged.
  const serialize = () =>
    $hasInlineFormatting($getRoot())
      ? $convertToMarkdownString(CHAT_MARKDOWN_TRANSFORMERS)
      : $getRoot().getTextContent();

  it('reports no inline formatting for plain text', () => {
    const hasFormatting = withEditor(
      () => setParagraph(p => p.append($createTextNode('hello world'))),
      () => $hasInlineFormatting($getRoot())
    );
    expect(hasFormatting).toBe(false);
  });

  it('sends plain text verbatim and does NOT escape literal markdown (no regression)', () => {
    // A user typing literal `*foo*` (not via Ctrl+I) must keep the asterisks so
    // ReactMarkdown still renders them - never escaped to `\*foo\*`.
    const sent = withEditor(() => setParagraph(p => p.append($createTextNode('*foo* and _bar_'))), serialize);
    expect(sent).toBe('*foo* and _bar_');
    expect(sent).not.toContain('\\*');
  });

  it('detects inline formatting and serializes bold to markdown', () => {
    const sent = withEditor(() => {
      setParagraph(p => {
        const node = $createTextNode('bold');
        node.toggleFormat('bold');
        p.append(node);
      });
    }, serialize);
    expect(sent).toBe('**bold**');
  });

  it('serializes italic (Ctrl+I) to markdown', () => {
    const sent = withEditor(() => {
      setParagraph(p => {
        const node = $createTextNode('italic');
        node.toggleFormat('italic');
        p.append(node);
      });
    }, serialize);
    expect(sent).toBe('*italic*');
  });

  it('serializes a mix of plain and bold text', () => {
    const sent = withEditor(() => {
      setParagraph(p => {
        p.append($createTextNode('see '));
        const node = $createTextNode('this');
        node.toggleFormat('bold');
        p.append(node);
      });
    }, serialize);
    expect(sent).toBe('see **this**');
  });

  it('does NOT treat underline as formatting — an unserializable format keeps the plain-text path', () => {
    // RichTextPlugin registers Ctrl+U, but TEXT_FORMAT_TRANSFORMERS has no
    // underline transformer. A user who underlines literal `*foo*` must still
    // get the plain-text path so the asterisks are not escaped to `\*foo\*`.
    const { hasFormatting, sent } = withEditor(
      () =>
        setParagraph(p => {
          const node = $createTextNode('*foo*');
          node.toggleFormat('underline');
          p.append(node);
        }),
      () => ({ hasFormatting: $hasInlineFormatting($getRoot()), sent: serialize() })
    );
    expect(hasFormatting).toBe(false);
    expect(sent).toBe('*foo*');
    expect(sent).not.toContain('\\*');
  });

  it('serializes a mention alongside bold formatting without dropping the mention', () => {
    // The user @-mentions an agent AND applies Ctrl+B. The sent string is what
    // renders in the bubble, so the mention token must survive markdown serialization.
    const sent = withEditor(() => {
      setParagraph(p => {
        p.append($createBeautifulMentionNode('@', 'researcher'));
        p.append($createTextNode(' '));
        const node = $createTextNode('world');
        node.toggleFormat('bold');
        p.append(node);
      });
    }, serialize);
    expect(sent).toContain('@researcher');
    expect(sent).toContain('**world**');
  });
});
