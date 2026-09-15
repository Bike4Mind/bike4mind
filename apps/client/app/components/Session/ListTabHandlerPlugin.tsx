// ListTabHandlerPlugin.tsx - Handle Tab/Shift+Tab for list indentation

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  COMMAND_PRIORITY_LOW,
  KEY_TAB_COMMAND,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import { $isCodeNode } from '@lexical/code-core';
import { $isListItemNode } from '@lexical/list';
import { $findMatchingParent } from '@lexical/utils';
import { useEffect } from 'react';

/**
 * Plugin to handle Tab/Shift+Tab for list indentation
 * Prevents default browser Tab behavior (focus cycling) when inside lists
 * and dispatches proper INDENT/OUTDENT commands instead
 */
export function ListTabHandlerPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_TAB_COMMAND,
      (event: KeyboardEvent) => {
        // Check if mentions menu is open - let it handle Tab for navigation
        const mentionsMenu = document.querySelector('.beautiful-mentions-menu, .custom-mentions-menu-upward');
        if (mentionsMenu) {
          return false; // Let mentions menu handle Tab
        }

        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false; // Not a text selection, allow default Tab
        }

        const anchorNode = selection.anchor.getNode();

        // Check if we're in a code block - let it handle Tab for code indentation
        try {
          const element = anchorNode.getTopLevelElementOrThrow();
          if ($isCodeNode(element)) {
            return false; // Let code block handle Tab
          }
        } catch (error) {
          // Node structure is invalid, allow default Tab
          return false;
        }

        // Check if we're inside a list item (traverse entire ancestor tree)
        const listItem = $findMatchingParent(anchorNode, $isListItemNode);
        if (listItem !== null) {
          // We're in a list - prevent default Tab and dispatch indent/outdent
          event.preventDefault();

          if (event.shiftKey) {
            // Shift+Tab: Outdent the list item
            editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
          } else {
            // Tab: Indent the list item
            editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
          }

          return true; // We handled the command
        }

        // Not in a list - allow default Tab behavior (accessibility/focus cycling)
        return false;
      },
      COMMAND_PRIORITY_LOW // Use LOW priority to let other plugins handle first if needed
    );
  }, [editor]);

  return null;
}
