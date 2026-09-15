// CodeHighlightPlugin.tsx - Enables syntax highlighting in code blocks

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { registerCodeHighlighting } from '@lexical/code-prism';
import { useEffect } from 'react';
import './prism-languages'; // Import all supported Prism language definitions

/**
 * Plugin to enable syntax highlighting in code blocks using Prism.js
 *
 * This plugin uses Lexical's built-in code highlighting functionality which:
 * - Tokenizes code using Prism.js
 * - Applies CSS classes based on token types
 * - Supports multiple programming languages
 */
export function CodeHighlightPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Register code highlighting with the editor
    // This will automatically use Prism.js for tokenization
    return registerCodeHighlighting(editor);
  }, [editor]);

  return null;
}
