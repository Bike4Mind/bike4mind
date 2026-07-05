// Syncs external value changes into the Lexical editor

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import React, { useEffect, useRef } from 'react';

interface SyncValuePluginProps {
  value: string;
  skipSyncRef?: React.MutableRefObject<boolean>;
}

export function SyncValuePlugin({ value, skipSyncRef }: SyncValuePluginProps): null {
  const [editor] = useLexicalComposerContext();
  const isUpdatingRef = useRef(false);
  const previousValueRef = useRef(value);

  useEffect(() => {
    // Skip if we're in the middle of an update
    if (isUpdatingRef.current) {
      return;
    }

    // Skip if direct tree insertion is in progress
    if (skipSyncRef?.current) {
      previousValueRef.current = value; // Update ref to prevent future sync
      return;
    }

    // Skip if value hasn't changed
    if (value === previousValueRef.current) {
      return;
    }

    previousValueRef.current = value;

    // Strip snippet metadata for display (but keep in parent state)
    const displayValue = value.replace(/<!--snippet-meta.*?-->\n?/g, '');

    editor.update(() => {
      isUpdatingRef.current = true;

      const root = $getRoot();
      const currentText = root.getTextContent();

      if (currentText !== displayValue) {
        root.clear();

        const paragraph = $createParagraphNode();
        const textNode = $createTextNode(displayValue);
        paragraph.append(textNode);
        root.append(paragraph);

        paragraph.selectEnd();
      }

      // Reset the flag after the update commits, not synchronously
      queueMicrotask(() => {
        isUpdatingRef.current = false;
      });
    });
  }, [editor, value]);

  return null;
}
