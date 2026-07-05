import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { $convertToMarkdownString } from '@lexical/markdown';
import { CodeNode, CodeHighlightNode } from '@lexical/code-core';
import { ListNode, ListItemNode } from '@lexical/list';
import { BeautifulMentionNode, $createBeautifulMentionNode } from 'lexical-beautiful-mentions';
import {
  LexicalChatInput,
  LexicalChatInputRef,
  CHAT_MARKDOWN_TRANSFORMERS,
  $hasInlineFormatting,
} from '../LexicalChatInput';

// TODO: Fix tests - userEvent.keyboard() doesn't trigger Lexical onChange in CI
// See: https://github.com/facebook/lexical/discussions/3948
describe.skip('LexicalChatInput - Integration Tests', () => {
  let user: ReturnType<typeof userEvent.setup>;
  let onChange: ReturnType<typeof vi.fn>;
  let onSubmit: ReturnType<typeof vi.fn>;

  const mockAgents = [
    { id: '1', name: 'Agent1', triggerWords: ['@agent1'] },
    { id: '2', name: 'Agent2', triggerWords: ['@agent2'] },
  ];

  beforeEach(() => {
    user = userEvent.setup();
    onChange = vi.fn();
    onSubmit = vi.fn();
  });

  it('should render and accept text input', async () => {
    render(<LexicalChatInput value="" onChange={onChange} placeholder="Type here..." agents={mockAgents} />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.keyboard('Hello world');

    await waitFor(() => {
      // onChange should be called with the text content
      expect(onChange).toHaveBeenCalled();
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
      expect(lastCall[0]).toContain('Hello');
    });
  });

  it('should call onSubmit when Enter is pressed', async () => {
    render(
      <LexicalChatInput
        value=""
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="Type here..."
        agents={mockAgents}
      />
    );

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.keyboard('Test message{Enter}');

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });

  it('should create newline with Shift+Enter', async () => {
    render(
      <LexicalChatInput
        value=""
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="Type here..."
        agents={mockAgents}
      />
    );

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.keyboard('Line 1{Shift>}{Enter}{/Shift}Line 2');

    // Wait a bit to ensure onSubmit is not called
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(onSubmit).not.toHaveBeenCalled();
    // onChange should have been called with multiline text
    expect(onChange).toHaveBeenCalled();
  });

  it('should export markdown via ref', async () => {
    const ref = React.createRef<LexicalChatInputRef>();

    render(<LexicalChatInput ref={ref} value="" onChange={onChange} placeholder="Type here..." agents={mockAgents} />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.keyboard('Test content');

    await waitFor(() => {
      expect(ref.current).toBeDefined();
      const markdown = ref.current?.getMarkdown();
      expect(markdown).toBeDefined();
      expect(typeof markdown).toBe('string');
    });
  });

  it('should handle placeholder prop', () => {
    const customPlaceholder = 'Custom placeholder text';

    render(<LexicalChatInput value="" onChange={onChange} placeholder={customPlaceholder} agents={mockAgents} />);

    // The editor should have the placeholder in aria-placeholder
    const editor = screen.getByRole('textbox');
    expect(editor).toHaveAttribute('aria-placeholder', customPlaceholder);
  });

  it('should have proper accessibility attributes', () => {
    render(<LexicalChatInput value="" onChange={onChange} placeholder="Type here..." agents={mockAgents} />);

    const editor = screen.getByRole('textbox');
    expect(editor).toHaveAttribute('role', 'textbox');
    expect(editor).toHaveAttribute('aria-label', 'Chat message input');
    expect(editor).toHaveAttribute('aria-multiline', 'true');
  });

  it('should handle agent mentions', async () => {
    render(<LexicalChatInput value="" onChange={onChange} placeholder="Type here..." agents={mockAgents} />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.keyboard('@agent1');

    await waitFor(() => {
      // The text should contain the mention
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
      expect(lastCall[0]).toContain('@agent1');
    });
  });

  it('should handle inline code transformation', async () => {
    render(<LexicalChatInput value="" onChange={onChange} placeholder="Type here..." agents={mockAgents} />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.keyboard('Use `console.log`');

    await waitFor(() => {
      // onChange should be called
      expect(onChange).toHaveBeenCalled();
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
      // The backticks should be transformed (text content won't have them)
      expect(lastCall[0]).toContain('console.log');
    });
  });

  it('should update when value prop changes', async () => {
    const { rerender } = render(
      <LexicalChatInput value="Initial value" onChange={onChange} placeholder="Type here..." agents={mockAgents} />
    );

    // Update with new value
    rerender(
      <LexicalChatInput value="Updated value" onChange={onChange} placeholder="Type here..." agents={mockAgents} />
    );

    await waitFor(() => {
      // The editor should sync with the new value
      expect(onChange).toHaveBeenCalled();
    });
  });

  it('should handle empty agent list', async () => {
    render(<LexicalChatInput value="" onChange={onChange} placeholder="Type here..." agents={[]} />);

    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.keyboard('Test with no agents');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
      expect(lastCall[0]).toContain('Test with no agents');
    });
  });
});

// Markdown round-trip serialization.
//
// These exercise the pure serialization logic behind `getSerializedValue()`
// against a headless Lexical editor. We drive the editor state directly rather
// than through `userEvent.keyboard()` because the latter doesn't trigger
// Lexical's onChange under jsdom (see the skipped suite above), which would
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
