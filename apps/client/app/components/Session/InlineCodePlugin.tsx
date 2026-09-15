// InlineCodePlugin.tsx - Custom plugin to handle inline code WYSIWYG transformation

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createTextNode, $getSelection, $isRangeSelection, TextNode } from 'lexical';
import { useEffect } from 'react';

/**
 * Plugin to transform `code` into styled inline code without backticks
 *
 * When user types: `code`
 * Displays as styled "code" (no backticks visible)
 *
 * Uses registerNodeTransform which is Lexical's recommended approach for
 * transforming nodes based on their content.
 */
export function InlineCodePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Register a transform on TextNode to detect and format inline code
    const removeTransform = editor.registerNodeTransform(TextNode, (node: TextNode) => {
      // Skip if node already has code format (avoid infinite loops)
      if (node.hasFormat('code')) {
        return;
      }

      const text = node.getTextContent();

      // Match ALL inline code patterns in the text: `code`
      const inlineCodeRegex = /`([^`\n]+)`/g;
      let match;
      const matches: Array<{ start: number; end: number; content: string }> = [];

      // Find all matches
      while ((match = inlineCodeRegex.exec(text)) !== null) {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          content: match[1],
        });
      }

      // If no matches, nothing to transform
      if (matches.length === 0) {
        return;
      }

      // Check if cursor is at the end of the last match (user just typed closing backtick)
      const selection = $getSelection();
      let shouldMoveCursor = false;
      let lastMatchEnd = 0;

      if ($isRangeSelection(selection) && matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        lastMatchEnd = lastMatch.end;
        // Check if cursor is right after the last closing backtick
        // Also check that cursor is in the current node being transformed
        shouldMoveCursor =
          selection.focus.offset === lastMatchEnd && selection.focus.getNode().getKey() === node.getKey();
      }

      // Process matches from right to left to maintain indices
      // Split the text node into multiple nodes: plain text and code nodes
      const currentNode = node;
      let processed = 0;
      let lastCodeNode: TextNode | null = null;

      for (let i = 0; i < matches.length; i++) {
        const { start, end, content } = matches[i];

        // Text before this match
        const beforeText = text.substring(processed, start);
        if (beforeText) {
          const beforeNode = $createTextNode(beforeText);
          currentNode.insertBefore(beforeNode);
        }

        // The code content (without backticks)
        const codeNode = $createTextNode(content);
        codeNode.setFormat('code');
        currentNode.insertBefore(codeNode);
        lastCodeNode = codeNode;

        processed = end;
      }

      // Text after the last match - always add space to facilitate continued typing
      const afterText = text.substring(processed);
      let afterNode: TextNode;

      if (afterText) {
        afterNode = $createTextNode(afterText);
      } else {
        afterNode = $createTextNode(' ');
      }
      currentNode.insertBefore(afterNode);

      // Remove the original node
      currentNode.remove();

      // Only move cursor if user just typed the closing backtick
      if (shouldMoveCursor && lastCodeNode) {
        // Use setTimeout with longer delay to ensure transform is complete
        setTimeout(() => {
          editor.update(() => {
            try {
              // Get the latest version of the after node
              const latestAfterNode = afterNode.getLatest();
              const latestCodeNode = lastCodeNode.getLatest();

              // Check if cursor is still in the code node
              const currentSelection = $getSelection();
              if ($isRangeSelection(currentSelection)) {
                const focusNode = currentSelection.focus.getNode();
                // If cursor is in the code node, move it to the after node
                if (
                  focusNode.getKey() === latestCodeNode.getKey() ||
                  (focusNode.getType() === 'text' && (focusNode as TextNode).hasFormat('code'))
                ) {
                  latestAfterNode.select(0, 0);
                }
              }
            } catch (error) {
              // Node may have been removed or transformed again, ignore
              console.debug('Could not position cursor after inline code transformation');
            }
          });
        }, 10);
      }
    });

    return () => {
      removeTransform();
    };
  }, [editor]);

  return null;
}
