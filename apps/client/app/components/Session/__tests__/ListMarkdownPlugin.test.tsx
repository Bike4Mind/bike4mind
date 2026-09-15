import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { ListMarkdownPlugin } from '../ListMarkdownPlugin';
import { ListNode, ListItemNode } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $isElementNode } from 'lexical';

// Helper to check if list was created
function ListChecker({ testId }: { testId: string }) {
  const [editor] = useLexicalComposerContext();

  const hasListNode = () => {
    let foundList = false;
    editor.getEditorState().read(() => {
      const root = $getRoot();
      root.getChildren().forEach(child => {
        if ($isElementNode(child) && child.getType() === 'list') {
          foundList = true;
        }
      });
    });
    return foundList;
  };

  return <div data-testid={testId}>{hasListNode() ? 'has-list' : 'no-list'}</div>;
}

// Test editor component
function TestEditor() {
  const initialConfig = {
    namespace: 'Test',
    theme: {},
    nodes: [ListNode, ListItemNode],
    onError: (error: Error) => console.error(error),
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin
        contentEditable={<ContentEditable data-testid="editor" role="textbox" aria-label="Test editor" />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <ListPlugin />
      <ListMarkdownPlugin />
      <ListChecker testId="list-checker" />
    </LexicalComposer>
  );
}

// TODO: Fix tests - userEvent.keyboard() doesn't trigger Lexical plugins in CI
// See: https://github.com/facebook/lexical/discussions/3948
describe.skip('ListMarkdownPlugin', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it('should convert "- " to bullet list', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('- ');

    await waitFor(() => {
      const checker = screen.getByTestId('list-checker');
      expect(checker.textContent).toBe('has-list');
    });
  });

  it('should convert "1. " to numbered list', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('1. ');

    await waitFor(() => {
      const checker = screen.getByTestId('list-checker');
      expect(checker.textContent).toBe('has-list');
    });
  });

  it('should handle multi-digit numbered lists "42. "', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('42. ');

    await waitFor(() => {
      const checker = screen.getByTestId('list-checker');
      expect(checker.textContent).toBe('has-list');
    });
  });

  it('should not convert dash without space', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('-');

    await waitFor(() => {
      const checker = screen.getByTestId('list-checker');
      expect(checker.textContent).toBe('no-list');
    });
  });

  it('should not convert when already in a list', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    // First create a list
    await user.keyboard('- ');

    await waitFor(async () => {
      const checker = screen.getByTestId('list-checker');
      expect(checker.textContent).toBe('has-list');

      // Try to create another list within the list
      // (This should just create a new list item, not a nested list)
      await user.keyboard('item{Enter}- ');
    });
  });

  it('should not convert "1.5 " (decimal numbers)', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('1.5 '); // Decimal, not integer

    // Give time for potential transformation
    await new Promise(resolve => setTimeout(resolve, 100));

    const checker = screen.getByTestId('list-checker');
    // Should NOT create list because regex requires integer only
    expect(checker.textContent).toBe('no-list');
  });

  it('should handle text before dash marker', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('Some text- ');

    // Should not create list when dash is not at start of line
    await new Promise(resolve => setTimeout(resolve, 100));

    const checker = screen.getByTestId('list-checker');
    // Plugin checks for start of line, so this might depend on implementation
    // Based on code, it checks getCurrentLineText which gets text from last line break
    // "Some text-" would be the line text, which is NOT just "-"
    expect(checker.textContent).toBe('no-list');
  });
});
