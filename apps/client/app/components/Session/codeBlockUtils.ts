// codeBlockUtils.ts - Utility functions for code block arrow key navigation

import type { LexicalEditor, LexicalNode, RangeSelection, ElementNode, NodeKey } from 'lexical';
import { $getSelection, $isRangeSelection, $createParagraphNode, $isParagraphNode, $getNodeByKey } from 'lexical';
import { $isCodeNode } from '@lexical/code-core';
import type { CodeNode } from '@lexical/code-core';

/**
 * Delay in milliseconds to allow CodeHighlightPlugin transforms to complete
 * before moving cursor to the new paragraph after exiting a code block
 */
const CODE_HIGHLIGHT_PLUGIN_TRANSFORM_DELAY_MS = 10;

/**
 * Direction for arrow key navigation
 */
type ArrowDirection = 'up' | 'down';

/**
 * Calculates the absolute cursor offset within a CodeNode by traversing its children
 * @param element - The CodeNode to traverse
 * @param anchorNode - The node where the cursor is positioned
 * @param selectionOffset - The offset within the anchor node
 * @returns Object containing the absolute offset and whether the anchor was found
 */
export function calculateAbsoluteOffset(
  element: CodeNode,
  anchorNode: LexicalNode,
  selectionOffset: number
): { offset: number; found: boolean } {
  let absoluteOffset = 0;
  let foundAnchor = false;

  const traverseChildren = (node: ElementNode): boolean => {
    const children = node.getChildren();
    for (const child of children) {
      if (child.getKey() === anchorNode.getKey()) {
        absoluteOffset += selectionOffset;
        foundAnchor = true;
        return true;
      }

      // Check if child has children (is an ElementNode) using runtime check
      if ('getChildrenSize' in child && typeof child.getChildrenSize === 'function' && child.getChildrenSize() > 0) {
        if (traverseChildren(child as ElementNode)) {
          return true;
        }
      } else {
        absoluteOffset += child.getTextContent().length;
      }
    }
    return false;
  };

  traverseChildren(element);
  return { offset: absoluteOffset, found: foundAnchor };
}

/**
 * Checks if the arrow key command should be handled
 * Performs safety checks for IME composition, modifier keys, selection state, and code node validation
 * @param event - Keyboard event
 * @param selection - Current selection
 * @param element - Current top-level element
 * @returns true if the command should be handled, false otherwise
 */
export function shouldHandleArrowCommand(
  event: KeyboardEvent | null,
  selection: RangeSelection | null,
  element: ElementNode | null
): boolean {
  // Don't interfere with IME composition (CJK language input)
  if (event?.isComposing) {
    return false;
  }

  // Don't interfere with modifier keys (Shift extends selection, Ctrl/Cmd jumps, etc.)
  if (event?.shiftKey || event?.ctrlKey || event?.metaKey || event?.altKey) {
    return false;
  }

  // Only trigger on valid range selection
  if (!selection || !$isRangeSelection(selection)) {
    return false;
  }

  // Only trigger on cursor position, not range selection
  if (!selection.isCollapsed()) {
    return false;
  }

  // Check if we're in a code block
  if (!element || !$isCodeNode(element)) {
    return false;
  }

  return true;
}

/**
 * Defers paragraph selection so CodeHighlightPlugin transforms finish first,
 * avoiding a race when selecting the paragraph after a code-block exit.
 *
 * Takes a getter (() => NodeKey) rather than the key itself so the deferred
 * callback reads the key the caller assigns inside its own editor.update().
 *
 * @param editor - Lexical editor instance
 * @param getParagraphKey - Getter returning the paragraph node key
 */
export function deferParagraphSelection(editor: LexicalEditor, getParagraphKey: () => NodeKey): void {
  setTimeout(() => {
    editor.update(() => {
      try {
        const paragraphKey = getParagraphKey();
        const node = $getNodeByKey(paragraphKey);
        if (!node || !$isParagraphNode(node)) return;

        // Check if selection is still in the code block
        const currentSelection = $getSelection();
        if ($isRangeSelection(currentSelection)) {
          const currentAnchor = currentSelection.anchor.getNode();
          try {
            const topElement = currentAnchor.getTopLevelElementOrThrow();

            // Only move selection if still in code block
            if ($isCodeNode(topElement)) {
              node.select();
            }
          } catch (error) {
            // Node structure changed, safe to ignore
          }
        }
      } catch (error) {
        console.debug('Could not position cursor after code block exit:', error);
      }
    });
  }, CODE_HIGHLIGHT_PLUGIN_TRANSFORM_DELAY_MS);
}

/**
 * Creates an arrow key exit handler for code blocks
 * Handles exiting code blocks at boundary positions (start of first line / end of last line)
 * @param editor - Lexical editor instance
 * @param direction - Direction of arrow key ('up' or 'down')
 * @returns Command handler function
 */
export function createArrowExitHandler(editor: LexicalEditor, direction: ArrowDirection) {
  const isUp = direction === 'up';

  return (event: KeyboardEvent | null): boolean => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return false;
    }

    const anchorNode = selection.anchor.getNode();

    // Safety check: ensure we can get a top-level element
    let element: ElementNode;
    try {
      element = anchorNode.getTopLevelElementOrThrow();
    } catch (error) {
      return false;
    }

    // Perform all safety checks
    if (!shouldHandleArrowCommand(event, selection, element)) {
      return false;
    }

    // TypeScript narrowing - we know element is a CodeNode now
    const codeElement = element as CodeNode;

    const textContent = codeElement.getTextContent();
    const lines = textContent.split('\n');

    // Calculate absolute offset within the CodeNode
    const result = calculateAbsoluteOffset(codeElement, anchorNode, selection.anchor.offset);

    // Fallback if we didn't find anchor
    if (!result.found) {
      return false;
    }

    // Determine current line index
    const textBeforeCursor = textContent.substring(0, result.offset);
    const currentLineIndex = textBeforeCursor.split('\n').length - 1;

    // Check if we're on the target line (first for up, last for down)
    const targetLineIndex = isUp ? 0 : lines.length - 1;
    if (currentLineIndex !== targetLineIndex) {
      return false; // Not on target line, allow normal arrow navigation
    }

    // Check if cursor is at target position (start for up, end for down)
    const currentLine = lines[currentLineIndex] || '';
    const lineStartOffset = textBeforeCursor.lastIndexOf('\n') + 1;
    const cursorOffsetInLine = result.offset - lineStartOffset;
    const targetOffset = isUp ? 0 : currentLine.length;

    if (cursorOffsetInLine !== targetOffset) {
      return false; // Not at target position, allow normal arrow navigation
    }

    // We're at the boundary - exit the code block
    event?.preventDefault();

    // Will be assigned synchronously in editor.update()
    let paragraphKey: NodeKey;

    editor.update(() => {
      // Check if there's already a paragraph at the target position
      const sibling = isUp ? codeElement.getPreviousSibling() : codeElement.getNextSibling();

      if (sibling && $isParagraphNode(sibling)) {
        // Navigate to existing paragraph
        paragraphKey = sibling.getKey();
      } else {
        // Create a paragraph at the target position
        const paragraphNode = $createParagraphNode();
        if (isUp) {
          codeElement.insertBefore(paragraphNode);
        } else {
          codeElement.insertAfter(paragraphNode);
        }
        paragraphKey = paragraphNode.getKey();
      }
    });

    // Getter defers reading paragraphKey until after editor.update() assigns it.
    deferParagraphSelection(editor, () => paragraphKey);

    return true; // Command handled
  };
}
