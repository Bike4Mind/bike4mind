// CodeBlockPlugin.tsx - Custom plugin to handle code block WYSIWYG transformation

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createCodeNode, $isCodeNode } from '@lexical/code-core';
import {
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  $isParagraphNode,
  $createTextNode,
  $getNodeByKey,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ENTER_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
} from 'lexical';
import { useEffect } from 'react';
import { createArrowExitHandler } from './codeBlockUtils';

/**
 * Plugin to transform ```language into code blocks
 *
 * When user types:
 * ```javascript
 * code here
 * ```
 *
 * It creates a CodeNode with syntax highlighting
 */
export function CodeBlockPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();

        // Safety check: ensure we can get a top-level element
        let element;
        try {
          element = anchorNode.getTopLevelElementOrThrow();
        } catch (error) {
          // Node structure is invalid (e.g., during editor clearing)
          return false;
        }

        const elementKey = element.getKey();
        const elementDOM = editor.getElementByKey(elementKey);

        // Check if we're in a code block
        if ($isCodeNode(element)) {
          // Allow normal Enter behavior inside code blocks (create newlines)
          return false;
        }

        // Check if the paragraph ends with ```language pattern
        const paragraphText = element.getTextContent();
        const codeBlockMatch = paragraphText.match(/```(\w*)$/);

        if (codeBlockMatch) {
          // Verify cursor is at the end (right after ```)
          const cursorOffset = selection.anchor.offset;
          const anchorText = anchorNode.getTextContent();

          // Only proceed if cursor is at end of the node containing ```
          if (cursorOffset !== anchorText.length) {
            return false; // Cursor not at end, don't trigger
          }

          // User typed ```language and pressed Enter - create code block
          event?.preventDefault();

          const language = codeBlockMatch[1] || 'javascript';

          editor.update(() => {
            // Create a code block node
            const codeNode = $createCodeNode(language);

            // Check if the paragraph starts with ``` (no text before the marker)
            // Extract text before the ``` marker and check if it's empty/whitespace
            const textBeforeMarker = paragraphText.substring(0, paragraphText.length - codeBlockMatch[0].length).trim();
            const hasOnlyCodeBlockMarker = textBeforeMarker.length === 0;

            if (hasOnlyCodeBlockMarker) {
              // Paragraph only contains ```, replace the entire paragraph
              element.replace(codeNode);
            } else {
              // Paragraph has text before ``` marker
              // Check if anchorNode contains all the text or just the ``` part
              const anchorText = anchorNode.getTextContent();

              if (anchorText === paragraphText) {
                // Single text node contains everything: "test ```javascript"
                // Replace with just the text before ```
                const newTextNode = $createTextNode(textBeforeMarker);
                anchorNode.replace(newTextNode);
                // Insert code block after paragraph
                element.insertAfter(codeNode);
              } else {
                // Multiple nodes (e.g., "test" + linebreak + "```javascript")
                // Remove only the anchor node (which contains just ```)
                anchorNode.remove();

                // Remove trailing line breaks
                const children = element.getChildren();
                for (let i = children.length - 1; i >= 0; i--) {
                  const child = children[i];
                  if (child.getType() === 'linebreak') {
                    child.remove();
                  } else {
                    break;
                  }
                }

                // Insert code block after paragraph
                element.insertAfter(codeNode);
              }
            }

            // Focus the code block
            codeNode.select();

            // Note: Paragraph after code block will be created by double-enter logic
          });

          return true; // Command handled
        }

        // Check if we're right after a code block and user pressed Enter
        // This helps exit the code block
        if (elementDOM && elementDOM.previousSibling) {
          const prevElement = elementDOM.previousSibling;
          if (prevElement && prevElement.nodeName === 'CODE') {
            // Allow normal behavior - insert paragraph
            return false;
          }
        }

        return false; // Let other handlers process Enter
      },
      COMMAND_PRIORITY_CRITICAL // Higher priority than SubmitOnEnterPlugin to check for code blocks first
    );
  }, [editor]);

  // Handle exiting code blocks with double Enter (empty line + Enter)
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();

        // Safety check: ensure we can get a top-level element
        let element;
        try {
          element = anchorNode.getTopLevelElementOrThrow();
        } catch (error) {
          // Node structure is invalid (e.g., during editor clearing)
          return false;
        }

        // Check if we're in a code block
        // Note: With CodeHighlightNode, anchorNode might be nested inside a CodeHighlightNode
        // so we need to get the parent CodeNode via getTopLevelElementOrThrow()
        if ($isCodeNode(element)) {
          const textContent = element.getTextContent();

          // Calculate absolute offset within the CodeNode by checking all descendants
          // We need to handle nested structures (CodeHighlightNodes wrapping TextNodes)
          let absoluteOffset = 0;
          let foundAnchor = false;

          // Recursive function to traverse all descendants
          const traverseChildren = (node: any): boolean => {
            const children = node.getChildren();
            for (const child of children) {
              if (child.getKey() === anchorNode.getKey()) {
                // Found the anchor node
                absoluteOffset += selection.anchor.offset;
                foundAnchor = true;
                return true;
              }

              // Check if anchor is nested inside this child
              if (child.getChildrenSize && child.getChildrenSize() > 0) {
                if (traverseChildren(child)) {
                  return true;
                }
                // If we recursed but didn't find anchor, the recursion already added all descendant lengths
                // Don't add child's length again (would double-count)
              } else {
                // No children, add this node's length
                absoluteOffset += child.getTextContent().length;
              }
            }
            return false;
          };

          traverseChildren(element);

          // Fallback: if we didn't find the anchor, use a simpler check
          if (!foundAnchor) {
            // Check if we're at the end by checking if anchorNode is the last descendant
            const lastChild = element.getLastDescendant();
            const isAtEnd =
              lastChild?.getKey() === anchorNode.getKey() &&
              selection.anchor.offset === anchorNode.getTextContent().length;

            const lines = textContent.split('\n');
            const lastLine = lines[lines.length - 1] || '';
            const isLastLineEmpty = lastLine.trim() === '';

            // Check if second-to-last line is also empty (double-Enter pattern)
            const hasPreviousLine = lines.length > 1;
            const secondLastLine = hasPreviousLine ? lines[lines.length - 2] || '' : '';
            const isSecondLastLineEmpty = hasPreviousLine && secondLastLine.trim() === '';

            if (isAtEnd && isLastLineEmpty && isSecondLastLineEmpty) {
              event?.preventDefault();

              // Store paragraph key for deferred selection
              let paragraphKey: string;

              editor.update(() => {
                // Remove trailing empty/whitespace lines by clearing and rebuilding the code node
                const cleanedLines = lines.slice(0, -2);
                const cleanedContent = cleanedLines.join('\n');

                // Clear the code node's children
                element.clear();

                // Add the cleaned content back
                const newTextNode = $createTextNode(cleanedContent);
                element.append(newTextNode);

                // Create a paragraph after the code block
                const paragraphNode = $createParagraphNode();
                element.insertAfter(paragraphNode);

                // Store key for deferred selection (after CodeHighlightPlugin transforms complete)
                paragraphKey = paragraphNode.getKey();
              });

              // Defer selection to allow CodeHighlightPlugin transforms to complete
              // Matches pattern from InlineCodePlugin.tsx:103-128
              setTimeout(() => {
                editor.update(() => {
                  try {
                    // Get latest version of paragraph using public API
                    const node = $getNodeByKey(paragraphKey);
                    if (!node || !$isParagraphNode(node)) return;

                    const paragraphNode = node; // Type narrowed to ParagraphNode

                    // Check if selection is still in the code block
                    const currentSelection = $getSelection();
                    if ($isRangeSelection(currentSelection)) {
                      const anchorNode = currentSelection.anchor.getNode();
                      const topElement = anchorNode.getTopLevelElementOrThrow();

                      // Only move selection if still in code block
                      if ($isCodeNode(topElement)) {
                        paragraphNode.select();
                      }
                    }
                  } catch (error) {
                    // Node may have been removed/transformed, ignore
                    console.debug('Could not position cursor after code block exit:', error);
                  }
                });
              }, 10);

              // Return true - we've handled the command and prevented default Enter behavior
              return true;
            }
            return false;
          }

          // Check if cursor is at the end
          const isAtEnd = absoluteOffset === textContent.length;

          // Check if the current line (where cursor is) is empty or has only whitespace
          // This handles both truly empty lines and lines with preserved indentation
          const lines = textContent.split('\n');
          const currentLineIndex = textContent.substring(0, absoluteOffset).split('\n').length - 1;
          const currentLine = lines[currentLineIndex] || '';
          const isCurrentLineEmpty = currentLine.trim() === '';

          // Also check if there's a previous line and it's also empty/whitespace
          // This ensures we're on the second Enter press (double-Enter pattern)
          const hasPreviousLine = currentLineIndex > 0;
          const previousLine = hasPreviousLine ? lines[currentLineIndex - 1] || '' : '';
          const isPreviousLineEmpty = hasPreviousLine && previousLine.trim() === '';

          // Exit code block if:
          // 1. Cursor is at the end
          // 2. Current line is empty/whitespace
          // 3. Previous line is also empty/whitespace (double-Enter pattern)
          if (isAtEnd && isCurrentLineEmpty && isPreviousLineEmpty) {
            event?.preventDefault();

            // Store paragraph key for deferred selection
            let paragraphKey: string;

            editor.update(() => {
              // Remove trailing empty/whitespace lines by clearing and rebuilding the code node
              const contentLines = textContent.split('\n');
              const cleanedLines = contentLines.slice(0, -2);
              const cleanedContent = cleanedLines.join('\n');

              // Clear the code node's children
              element.clear();

              // Add the cleaned content back
              const newTextNode = $createTextNode(cleanedContent);
              element.append(newTextNode);

              // Create a paragraph after the code block
              const paragraphNode = $createParagraphNode();
              element.insertAfter(paragraphNode);

              // Store key for deferred selection (after CodeHighlightPlugin transforms complete)
              paragraphKey = paragraphNode.getKey();
            });

            // Defer selection to allow CodeHighlightPlugin transforms to complete
            // Matches pattern from InlineCodePlugin.tsx:103-128
            setTimeout(() => {
              editor.update(() => {
                try {
                  // Get latest version of paragraph using public API
                  const node = $getNodeByKey(paragraphKey);
                  if (!node || !$isParagraphNode(node)) return;

                  const paragraphNode = node; // Type narrowed to ParagraphNode

                  // Check if selection is still in the code block
                  const currentSelection = $getSelection();
                  if ($isRangeSelection(currentSelection)) {
                    const anchorNode = currentSelection.anchor.getNode();
                    const topElement = anchorNode.getTopLevelElementOrThrow();

                    // Only move selection if still in code block
                    if ($isCodeNode(topElement)) {
                      paragraphNode.select();
                    }
                  }
                } catch (error) {
                  // Node may have been removed/transformed, ignore
                  console.debug('Could not position cursor after code block exit:', error);
                }
              });
            }, 10);

            return true; // Command handled
          }
        }

        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor]);

  // Handle exiting code blocks with down arrow (at end of last line)
  useEffect(() => {
    return editor.registerCommand(KEY_ARROW_DOWN_COMMAND, createArrowExitHandler(editor, 'down'), COMMAND_PRIORITY_LOW);
  }, [editor]);

  // Handle exiting code blocks with up arrow (at start of first line)
  useEffect(() => {
    return editor.registerCommand(KEY_ARROW_UP_COMMAND, createArrowExitHandler(editor, 'up'), COMMAND_PRIORITY_LOW);
  }, [editor]);

  return null;
}
