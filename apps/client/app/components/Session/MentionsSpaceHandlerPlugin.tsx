import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_HIGH, KEY_SPACE_COMMAND } from 'lexical';
import { $isBeautifulMentionNode } from 'lexical-beautiful-mentions';
import { useEffect } from 'react';

/**
 * Prevents double spaces after selecting a mention. Beautiful Mentions adds a
 * trailing space on selection, so a space keypress right after a mention (when a
 * space is already there) is intercepted and dropped.
 */
export function MentionsSpaceHandlerPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_SPACE_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();

        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false; // Not a collapsed cursor, let default behavior happen
        }

        const anchorNode = selection.anchor.getNode();
        const offset = selection.anchor.offset;

        // Check if we're at the start of a text node and the previous node is a mention
        if ($isTextNode(anchorNode) && offset === 0) {
          const previousSibling = anchorNode.getPreviousSibling();

          if (previousSibling && $isBeautifulMentionNode(previousSibling)) {
            // We're right after a mention node, check if there's already a space
            const textContent = anchorNode.getTextContent();

            if (textContent.startsWith(' ')) {
              // There's already a space at the start, don't add another
              event?.preventDefault();
              return true; // We handled it
            }
          }
        }

        // Check if we're at the end of a text node that comes after a mention
        if ($isTextNode(anchorNode) && offset === anchorNode.getTextContent().length) {
          const textContent = anchorNode.getTextContent();

          // If the text node is just a space and follows a mention, ignore additional spaces
          if (textContent === ' ') {
            const previousSibling = anchorNode.getPreviousSibling();

            if (previousSibling && $isBeautifulMentionNode(previousSibling)) {
              // We're in a space node right after a mention, don't add more spaces
              event?.preventDefault();
              return true;
            }
          }
        }

        return false; // Let default space handling proceed
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor]);

  return null;
}
