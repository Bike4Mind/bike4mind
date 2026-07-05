import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_CRITICAL, PASTE_COMMAND } from 'lexical';
import { useEffect } from 'react';

interface PasteHandlerPluginProps {
  onPaste: (event: ClipboardEvent) => Promise<boolean> | boolean; // Returns true if paste was handled
}

export function PasteHandlerPlugin({ onPaste }: PasteHandlerPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const result = onPaste(event);

        if (result instanceof Promise) {
          result.then(wasHandled => {
            // By the time the promise resolves Lexical may have already processed
            // the paste, so async handlers must call preventDefault() synchronously.
          });
          // Async path relies on preventDefault() having been called synchronously.
          return event.defaultPrevented;
        }

        if (result) {
          return true; // stop Lexical's default paste processing
        }

        // Allow default paste behavior for small text
        return false;
      },
      COMMAND_PRIORITY_CRITICAL // run before Lexical's internal paste handlers
    );
  }, [editor, onPaste]);

  return null;
}
