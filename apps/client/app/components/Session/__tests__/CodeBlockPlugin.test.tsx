import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { CodeBlockPlugin } from '../CodeBlockPlugin';
import { CodeNode } from '@lexical/code-core';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $isElementNode } from 'lexical';

// Helper to check if code block was created
function CodeBlockChecker({ testId }: { testId: string }) {
  const [editor] = useLexicalComposerContext();

  const hasCodeBlock = () => {
    let foundCode = false;
    editor.getEditorState().read(() => {
      const root = $getRoot();
      root.getChildren().forEach(child => {
        if ($isElementNode(child) && child.getType() === 'code') {
          foundCode = true;
        }
      });
    });
    return foundCode;
  };

  return <div data-testid={testId}>{hasCodeBlock() ? 'has-code' : 'no-code'}</div>;
}

// Test editor component
function TestEditor() {
  const initialConfig = {
    namespace: 'Test',
    theme: {
      code: 'test-code-block',
    },
    nodes: [CodeNode],
    onError: (error: Error) => console.error(error),
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <RichTextPlugin
        contentEditable={<ContentEditable data-testid="editor" role="textbox" aria-label="Test editor" />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <CodeBlockPlugin />
      <CodeBlockChecker testId="code-checker" />
    </LexicalComposer>
  );
}

// TODO: Fix tests - userEvent.keyboard() doesn't trigger Lexical plugins in CI
// See: https://github.com/facebook/lexical/discussions/3948
describe.skip('CodeBlockPlugin', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it('should create code block with ```{Enter}', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('```{Enter}');

    await waitFor(() => {
      const checker = screen.getByTestId('code-checker');
      expect(checker.textContent).toBe('has-code');
    });
  });

  it('should create code block with language ```javascript{Enter}', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('```javascript{Enter}');

    await waitFor(() => {
      const checker = screen.getByTestId('code-checker');
      expect(checker.textContent).toBe('has-code');
    });
  });

  it('should create code block with ```ts{Enter}', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('```ts{Enter}');

    await waitFor(() => {
      const checker = screen.getByTestId('code-checker');
      expect(checker.textContent).toBe('has-code');
    });
  });

  it('should not create code block without Enter', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('```'); // No Enter

    await new Promise(resolve => setTimeout(resolve, 100));

    const checker = screen.getByTestId('code-checker');
    expect(checker.textContent).toBe('no-code');
  });

  it('should handle text before triple backticks', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('Some text ```{Enter}');

    await waitFor(() => {
      const checker = screen.getByTestId('code-checker');
      // Should create code block and preserve "Some text" in a paragraph
      expect(checker.textContent).toBe('has-code');
    });
  });

  it('should not create code block if cursor not at end', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('```test');
    // Move cursor back and press Enter
    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{Enter}');

    await new Promise(resolve => setTimeout(resolve, 100));

    const checker = screen.getByTestId('code-checker');
    // Should NOT create code block because cursor wasn't at end of ```
    expect(checker.textContent).toBe('no-code');
  });

  it('should allow Enter inside code block for newlines', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('```{Enter}');

    await waitFor(async () => {
      const checker = screen.getByTestId('code-checker');
      expect(checker.textContent).toBe('has-code');

      // Type some code with newlines
      await user.keyboard('function test() {{}{Enter}  return true;{Enter}{}}{Enter}');

      // Should still have code block
      expect(checker.textContent).toBe('has-code');
    });
  });

  it('should exit code block with double Enter on empty line', async () => {
    render(<TestEditor />);
    const editor = screen.getByTestId('editor');

    await user.click(editor);
    await user.keyboard('```{Enter}');

    await waitFor(async () => {
      const checker = screen.getByTestId('code-checker');
      expect(checker.textContent).toBe('has-code');

      // Type code and then double Enter to exit
      await user.keyboard('console.log("test");{Enter}{Enter}');

      // Should still have code block, but cursor should be in paragraph after it
      // (The code block plugin creates a paragraph after double-enter)
      expect(checker.textContent).toBe('has-code');
    });
  });
});
