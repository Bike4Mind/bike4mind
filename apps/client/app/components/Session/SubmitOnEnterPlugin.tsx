// Handle Enter key to submit instead of newline

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_LOW, KEY_ENTER_COMMAND, $getSelection, $isRangeSelection } from 'lexical';
import { $isCodeNode } from '@lexical/code-core';
import { $isListItemNode } from '@lexical/list';
import { $findMatchingParent } from '@lexical/utils';
import { useEffect } from 'react';

interface SubmitOnEnterPluginProps {
  onSubmit: () => void;
}

/**
 * Plugin to handle Enter key submission
 * Prevents newline insertion and triggers submit callback
 */
export function SubmitOnEnterPlugin({ onSubmit }: SubmitOnEnterPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        // Check if Shift is pressed - allow newline with Shift+Enter
        if (event?.shiftKey) {
          return false; // Let Lexical handle Shift+Enter (insert newline)
        }

        // Check if mentions menu is open (Beautiful Mentions plugin will handle Enter)
        const mentionsMenu = document.querySelector('.beautiful-mentions-menu, .custom-mentions-menu-upward');
        if (mentionsMenu) {
          // Mentions menu is open, let the Beautiful Mentions plugin handle Enter
          return false;
        }

        // Check if we're inside a code block or list
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const anchorNode = selection.anchor.getNode();

          // Check if we're in a list item - traverse entire ancestor tree
          const listItem = $findMatchingParent(anchorNode, $isListItemNode);
          if (listItem !== null) {
            return false; // Let ListPlugin create new list items
          }

          // Safety check: ensure we can get a top-level element
          let element;
          try {
            element = anchorNode.getTopLevelElementOrThrow();
          } catch (error) {
            // Node structure is invalid (e.g., during editor clearing)
            // Safe to submit in this case
            event?.preventDefault();
            onSubmit();
            return true;
          }

          // If we're in a code block, let it handle Enter (create newlines)
          if ($isCodeNode(element)) {
            return false;
          }
        }

        // Prevent default Enter behavior (newline)
        event?.preventDefault();

        onSubmit();

        return true;
      },
      COMMAND_PRIORITY_LOW // Use LOW priority to let other plugins (mentions, code) handle first
    );
  }, [editor, onSubmit]);

  return null;
}
