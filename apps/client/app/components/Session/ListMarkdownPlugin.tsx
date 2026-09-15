// ListMarkdownPlugin.tsx - Custom markdown shortcuts for list creation
// Handles "- " for bullet lists and "1. " for numbered lists
// Works anywhere in the document, not just at the beginning

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isParagraphNode,
  $isLineBreakNode,
  TextNode,
  ParagraphNode,
  LexicalNode,
  COMMAND_PRIORITY_LOW,
  KEY_SPACE_COMMAND,
} from 'lexical';
import { $isListNode, $createListNode, $createListItemNode, ListType } from '@lexical/list';
import { useEffect } from 'react';

/**
 * Plugin to handle markdown shortcuts for list creation
 * Detects "- " or "1. " at the start of a paragraph and converts to list
 */
export function ListMarkdownPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_SPACE_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false; // Not a collapsed cursor, don't handle
        }

        const anchorNode = selection.anchor.getNode();

        // Check if we're in a paragraph (not already in a list or code block)
        const parent = anchorNode.getParent();
        if (!$isParagraphNode(parent)) {
          return false; // Not in a paragraph, don't handle
        }

        // Check if paragraph is already in a list
        const grandParent = parent.getParent();
        if ($isListNode(grandParent)) {
          return false; // Already in a list, don't handle
        }

        // Get the current line's text (text after the last line break or from start of paragraph)
        const currentLineText = getCurrentLineText(parent, anchorNode, selection.anchor.offset);

        // Check for bullet list pattern: "- " (dash followed by space we're about to type)
        if (currentLineText === '-') {
          event?.preventDefault(); // Prevent the space from being inserted
          convertToList('bullet', parent, anchorNode);
          return true; // We handled the space key
        }

        // Check for numbered list pattern: "1. " (digits, period, then space).
        // /^(\d+)\.$/ matches "1." or "42." but not "1.5" or "a."
        const numberedMatch = currentLineText.match(/^(\d+)\.$/);
        if (numberedMatch) {
          event?.preventDefault(); // Prevent the space from being inserted
          convertToList('number', parent, anchorNode);
          return true; // We handled the space key
        }

        return false; // Not a list pattern, let default space handling proceed
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor]);

  return null;
}

/**
 * Gets the text on the current line (from last line break or start of paragraph to cursor)
 */
function getCurrentLineText(paragraphNode: ParagraphNode, currentNode: LexicalNode, offset: number): string {
  // Get all children of the paragraph
  const children = paragraphNode.getChildren();

  let lineText = '';
  let reachedCursor = false;

  // Walk through children and collect text from last line break to cursor
  for (const child of children) {
    if (reachedCursor) {
      break; // Already collected text up to cursor
    }

    if ($isLineBreakNode(child)) {
      // Found a line break - reset the line text (start fresh from here)
      lineText = '';
      continue;
    }

    if (child === currentNode) {
      // This is the node where the cursor is
      // Add text from start of this node up to cursor offset
      const nodeText = child.getTextContent();
      lineText += nodeText.substring(0, offset);
      reachedCursor = true;
    } else {
      // Not the cursor node yet, add entire text
      lineText += child.getTextContent();
    }
  }

  return lineText;
}

/**
 * Converts a paragraph (or part of it) to a list item
 * Handles cases where there's text before the line (from Shift+Enter)
 */
function convertToList(listType: ListType, paragraphNode: ParagraphNode, currentNode: LexicalNode) {
  const children = paragraphNode.getChildren();

  // Find the last line break before the current node (if any)
  let lastLineBreakIndex = -1;

  for (let i = 0; i < children.length; i++) {
    if (children[i] === currentNode) {
      break;
    }
    if ($isLineBreakNode(children[i])) {
      lastLineBreakIndex = i;
    }
  }

  // Create a list and list item
  const list = $createListNode(listType);
  const listItem = $createListItemNode();
  const newTextNode = new TextNode('');
  listItem.append(newTextNode);
  list.append(listItem);

  if (lastLineBreakIndex === -1) {
    // No line break found - the entire paragraph should become a list
    // Just replace the paragraph with the list
    paragraphNode.replace(list);
  } else {
    // There's a line break - need to split the paragraph
    // Keep content before the line break in the paragraph
    // Remove the line break and content after it, and insert the list

    // Remove all nodes from the line break onwards
    for (let i = children.length - 1; i >= lastLineBreakIndex; i--) {
      children[i].remove();
    }

    // Insert the list after the paragraph
    paragraphNode.insertAfter(list);
  }

  // Move cursor to the empty text node in the list item
  newTextNode.select();
}
