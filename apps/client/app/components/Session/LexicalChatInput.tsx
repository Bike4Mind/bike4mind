// LexicalChatInput.tsx - Lexical-based WYSIWYG chat input with inline code and @mentions

import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  $createRangeSelection,
  $isElementNode,
  $isTextNode,
  $createTextNode,
  $createParagraphNode,
  $isParagraphNode,
  $createLineBreakNode,
  $getNodeByKey,
  EditorState,
  LexicalEditor,
  LexicalNode,
  TextFormatType,
} from 'lexical';
import { CodeNode, CodeHighlightNode, $createCodeNode, $isCodeNode } from '@lexical/code-core';
import {
  $convertToMarkdownString,
  CODE,
  INLINE_CODE,
  UNORDERED_LIST,
  ORDERED_LIST,
  TEXT_FORMAT_TRANSFORMERS,
} from '@lexical/markdown';
import { ListNode, ListItemNode } from '@lexical/list';
import { BeautifulMentionsPlugin, BeautifulMentionNode, $isBeautifulMentionNode } from 'lexical-beautiful-mentions';
import { SubmitOnEnterPlugin } from './SubmitOnEnterPlugin';
import { CodeBlockPlugin } from './CodeBlockPlugin';
import { CodeHighlightPlugin } from './CodeHighlightPlugin';
import { InlineCodePlugin } from './InlineCodePlugin';
import { MentionsMenuPositionPlugin } from './MentionsMenuPositionPlugin';
import { MentionsSpaceHandlerPlugin } from './MentionsSpaceHandlerPlugin';
import { PasteHandlerPlugin } from './PasteHandlerPlugin';
import { SyncValuePlugin } from './SyncValuePlugin';
import { PluginErrorBoundary } from './PluginErrorBoundary';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { ListTabHandlerPlugin } from './ListTabHandlerPlugin';
import { ListMarkdownPlugin } from './ListMarkdownPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import type { BeautifulMentionsMenuProps } from 'lexical-beautiful-mentions';
import React, { forwardRef, useImperativeHandle, useRef, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

// Custom menu component - minimal wrapper to preserve event handlers
// Memoized to prevent unnecessary re-renders when agent list hasn't changed
const CustomMentionsMenu = React.memo(
  forwardRef<HTMLUListElement, BeautifulMentionsMenuProps>(({ loading, ...props }, ref) => {
    return (
      <ul
        {...props}
        ref={ref}
        role="listbox"
        aria-label="Agent mentions"
        className="beautiful-mentions-menu custom-mentions-menu-upward"
        style={{
          ...props.style,
          // Let positioning plugin handle position, just add basic styles here
          margin: 0,
          padding: '4px 0',
          listStyle: 'none',
        }}
      />
    );
  })
);
CustomMentionsMenu.displayName = 'CustomMentionsMenu';

interface LexicalChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onPaste?: (event: ClipboardEvent) => Promise<boolean> | boolean; // Returns true if paste was handled
  placeholder?: string;
  agents: Array<{ id: string; name: string; triggerWords: string[] }>;
}

/**
 * A mention as stored in the editor tree. The `value` is the text the user
 * picked from the typeahead (e.g. `"research-lead"`), independent of the
 * trigger character. Always prefer this over re-parsing `getMarkdown()` with
 * a regex - the editor tree is the source of truth and survives hyphens,
 * dots, and anything else the BeautifulMentionsPlugin tokenized.
 */
export interface LexicalMention {
  trigger: string;
  value: string;
}

/**
 * Depth-first walk that collects every `BeautifulMentionNode` under `root` in
 * document order. Same mention appearing twice is returned twice - callers
 * dedupe by `value` if they need uniqueness. Must be called inside an
 * `editor.getEditorState().read()` block (the `$is*` helpers require an
 * active editor read).
 *
 * Exported for unit testing - `getMentions()` on the editor ref delegates here.
 */
export function $collectMentions(root: LexicalNode): LexicalMention[] {
  const mentions: LexicalMention[] = [];
  const walk = (node: LexicalNode): void => {
    if ($isBeautifulMentionNode(node)) {
      mentions.push({ trigger: node.getTrigger(), value: node.getValue() });
      return;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) walk(child);
    }
  };
  walk(root);
  return mentions;
}

/**
 * Transformers used when serializing the composer to markdown on send.
 * `TEXT_FORMAT_TRANSFORMERS` covers bold / italic / bold-italic / strikethrough /
 * highlight / inline-code, so Ctrl+B / Ctrl+I formatting round-trips into the
 * markdown that ReactMarkdown renders in the sent user bubble. `CODE`
 * and the list transformers preserve fenced code blocks and lists.
 */
export const CHAT_MARKDOWN_TRANSFORMERS = [CODE, ...TEXT_FORMAT_TRANSFORMERS, UNORDERED_LIST, ORDERED_LIST];

/**
 * Inline text formats that `CHAT_MARKDOWN_TRANSFORMERS` can actually serialize.
 *
 * Deliberately excludes underline / subscript / superscript: `RichTextPlugin`
 * registers their browser key-bindings (e.g. Ctrl+U), so a user CAN apply them,
 * but `TEXT_FORMAT_TRANSFORMERS` has no transformer for them. Treating those as
 * "formatted" would route the message through the markdown escaper and turn a
 * literal `*foo*` into `\*foo\*` while producing no underline - a regression
 * against the "no regression for literal markdown" criterion. Only the
 * formats listed here have a round-trip, so only they flip to the markdown path.
 */
const SERIALIZABLE_TEXT_FORMATS: TextFormatType[] = ['bold', 'italic', 'strikethrough', 'code', 'highlight'];

/**
 * True when any `TextNode` under `root` carries an inline format flag that
 * `CHAT_MARKDOWN_TRANSFORMERS` can serialize (see {@link SERIALIZABLE_TEXT_FORMATS}).
 * Must be called inside an `editor.getEditorState().read()` block (the `$is*`
 * helpers require an active editor read).
 *
 * Used to decide whether an outgoing message needs markdown serialization: when
 * the user applied no serializable formatting we emit plain text unchanged, which
 * preserves the long-standing behavior where literal markdown a user types (e.g.
 * `*foo*`) is sent verbatim and rendered by ReactMarkdown, rather than being
 * escaped to `\*foo\*` (no regression for literal markdown).
 *
 * Tradeoff: mixing literal markdown WITH applied formatting is lossy by design.
 * If a message both contains literal markdown (`*foo*`) AND has a serializable
 * format applied somewhere (e.g. another word bolded), this returns `true`, so
 * the whole message goes through `$convertToMarkdownString` and the literal
 * `*foo*` is escaped to `\*foo\*` (rendered with visible backslashes) while the
 * bolded word emits `**word**`. This is acceptable: the criterion is "no
 * regression for users who type literal markdown" - i.e. the no-formatting-applied
 * case - not "literal markdown and applied formatting coexist in one message."
 *
 * Exported for unit testing.
 */
export function $hasInlineFormatting(root: LexicalNode): boolean {
  let found = false;
  const walk = (node: LexicalNode): void => {
    if (found) return;
    if ($isTextNode(node) && SERIALIZABLE_TEXT_FORMATS.some(format => node.hasFormat(format))) {
      found = true;
      return;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) walk(child);
    }
  };
  walk(root);
  return found;
}

export interface LexicalChatInputRef {
  getMarkdown: () => string;
  /**
   * Returns the value to send: markdown when the composer contains inline
   * formatting (so Ctrl+B / Ctrl+I round-trips), otherwise the plain text
   * content unchanged (so literal markdown, slash-commands, and the char
   * counter are unaffected). See {@link $hasInlineFormatting}.
   */
  getSerializedValue: () => string;
  /**
   * Returns mentions in document order. Same mention appearing twice is
   * returned twice - callers dedupe by `value` if they need uniqueness.
   */
  getMentions: () => LexicalMention[];
  insertContent: (markdown: string) => void;
  setSelection: (start: number, end: number) => void;
  focus: () => void;
  blur: () => void;
}

// Plugin to expose markdown export, content insertion, selection control, and focus via ref
function EditorRefPlugin({
  onRef,
  skipSyncRef,
}: {
  onRef: (ref: LexicalChatInputRef) => void;
  skipSyncRef: React.MutableRefObject<boolean>;
}) {
  const [editor] = useLexicalComposerContext();

  // Expose the ref immediately
  useEffect(() => {
    onRef({
      getMarkdown: () => {
        let markdown = '';
        editor.getEditorState().read(() => {
          // Use Lexical's official markdown export with all transformers
          // (includes bold/italic/etc. via TEXT_FORMAT_TRANSFORMERS)
          markdown = $convertToMarkdownString(CHAT_MARKDOWN_TRANSFORMERS);
        });
        return markdown;
      },
      getSerializedValue: () => {
        let value = '';
        editor.getEditorState().read(() => {
          const root = $getRoot();
          // Only serialize to markdown when the user actually applied inline
          // formatting; otherwise emit plain text unchanged so literal markdown
          // (e.g. `*foo*`) is not escaped to `\*foo\*`.
          value = $hasInlineFormatting(root)
            ? $convertToMarkdownString(CHAT_MARKDOWN_TRANSFORMERS)
            : root.getTextContent();
        });
        return value;
      },
      getMentions: () => {
        let mentions: LexicalMention[] = [];
        editor.getEditorState().read(() => {
          mentions = $collectMentions($getRoot());
        });
        return mentions;
      },
      insertContent: (content: string) => {
        // Set flag to skip sync during this operation
        skipSyncRef.current = true;

        try {
          editor.update(() => {
            const root = $getRoot();

            // Check if content is ONLY a code block
            // Use markdown parser for code blocks to get proper syntax highlighting
            const isCodeBlock = /^```[a-zA-Z0-9_-]*\n[\s\S]*?\n?```$/.test(content.trim());

            // Check if content is ONLY a file tag
            // Insert file tags as plain text to avoid markdown link syntax conflicts
            const isFileTag = /^\[\[[^\]]+\]\]$/.test(content.trim());

            if (isCodeBlock) {
              // Pure code block - create CodeNode directly
              // Direct insertion avoids markdown parser regex issues
              const match = content.trim().match(/^```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n?```$/);
              if (match) {
                const [, language, code] = match;

                // Create CodeNode directly - CodeHighlightPlugin will add syntax highlighting
                const codeNode = $createCodeNode(language || undefined);

                // Create proper structure with LineBreakNodes (not \n in TextNodes)
                // This matches the structure Lexical creates when typing manually
                const lines = code.split('\n');
                for (let i = 0; i < lines.length; i++) {
                  // Add TextNode for non-empty lines
                  if (lines[i]) {
                    codeNode.append($createTextNode(lines[i]));
                  }

                  // Add LineBreakNode after each line (including trailing newlines)
                  // Skip only for the very last empty line from split
                  if (i < lines.length - 1) {
                    codeNode.append($createLineBreakNode());
                  } else if (code.endsWith('\n')) {
                    // Original code ended with newline, add trailing LineBreakNode
                    // This is crucial for double-Enter exit detection
                    codeNode.append($createLineBreakNode());
                  }
                }

                const lastChild = root.getLastChild();

                // If last child is a paragraph, clean up trailing linebreaks
                if ($isParagraphNode(lastChild)) {
                  // Remove only the LAST trailing linebreak (Shift+Enter creates LineBreakNode)
                  // Preserve all other linebreaks to maintain user's intentional spacing
                  const children = lastChild.getChildren();
                  if (children.length > 0) {
                    const lastLinebreak = children[children.length - 1];
                    if (lastLinebreak.getType() === 'linebreak') {
                      lastLinebreak.remove();
                    }
                  }

                  // Check if paragraph is now empty after linebreak removal
                  if (!lastChild.getTextContent().trim()) {
                    // Empty paragraph - insert code block after it, then remove the empty paragraph
                    // Using insertAfter + remove instead of replace to preserve previous empty paragraphs
                    lastChild.insertAfter(codeNode);
                    lastChild.remove();
                  } else {
                    // Has content - insert code block after it
                    lastChild.insertAfter(codeNode);
                  }
                } else {
                  // Last child is not a paragraph (e.g., another code block)
                  root.append(codeNode);
                }

                // Create paragraph after code block
                const paragraphNode = $createParagraphNode();
                codeNode.insertAfter(paragraphNode);

                // Do immediate selection (works for text-before case)
                paragraphNode.select();

                // Set up deferred cursor positioning inside editor.update() to ensure key is captured
                // Must use queueMicrotask or setTimeout to schedule AFTER this update completes
                const paragraphKey = paragraphNode.getKey(); // Capture for closure

                queueMicrotask(() => {
                  setTimeout(() => {
                    editor.update(() => {
                      try {
                        // Get latest version of paragraph using public API
                        const paragraphNode = $getNodeByKey(paragraphKey);
                        if (!paragraphNode || !$isParagraphNode(paragraphNode)) return;

                        // Check if cursor is currently in ANY code block
                        const currentSelection = $getSelection();
                        if ($isRangeSelection(currentSelection)) {
                          const focusNode = currentSelection.focus.getNode();

                          // Get top-level element to check if we're in a code block
                          try {
                            const topElement = focusNode.getTopLevelElementOrThrow();

                            // If cursor is in a code block, move it to the paragraph
                            if ($isCodeNode(topElement)) {
                              paragraphNode.select();
                            }
                          } catch (error) {
                            // getTopLevelElementOrThrow can fail during editor state changes, ignore
                          }
                        }
                      } catch (error) {
                        console.debug('Could not position cursor after code block paste:', error);
                      }
                    });
                  }, 10); // Minimal delay to allow transforms to settle (matches InlineCodePlugin pattern)
                });
              }
            } else if (isFileTag) {
              // Pure file tag - insert as plain text in new paragraph
              // Avoids markdown parser treating [[]] as link reference syntax
              const lastChild = root.getLastChild();

              // If last child is a paragraph with content, append to it with a space
              // Otherwise create a new paragraph for the file tag
              if ($isParagraphNode(lastChild) && lastChild.getTextContent().trim()) {
                // Append file tag to existing paragraph with a space separator
                lastChild.append($createTextNode(' ' + content.trim()));
              } else if ($isParagraphNode(lastChild)) {
                // Empty paragraph - append file tag to it
                lastChild.append($createTextNode(content.trim()));
              } else {
                // Last child is not a paragraph (e.g., code block) - create new paragraph
                const tagParagraph = $createParagraphNode();
                tagParagraph.append($createTextNode(content.trim()));
                root.append(tagParagraph);
              }
            } else {
              // Mixed content or plain text - insert as paragraph text
              const lastChild = root.getLastChild();
              if ($isParagraphNode(lastChild) && lastChild.getTextContent().trim()) {
                // Last paragraph has content - create new paragraph for spacing
                const newParagraph = $createParagraphNode();
                newParagraph.append($createTextNode(content));
                root.append(newParagraph);
              } else if ($isParagraphNode(lastChild)) {
                // Empty paragraph - reuse it
                lastChild.append($createTextNode(content));
              } else {
                // Last child is not a paragraph (e.g., code block) - create new paragraph
                const newParagraph = $createParagraphNode();
                newParagraph.append($createTextNode(content));
                root.append(newParagraph);
              }
            }

            // Move cursor to end so user can continue typing
            // Code blocks handle their own cursor positioning to avoid cursor being inside the block
            if (!isCodeBlock) {
              root.selectEnd();
            }
          });
        } catch (error) {
          console.error('Error inserting content into Lexical editor:', error);
          // Rethrow to let caller handle if needed
          throw error;
        } finally {
          // Always reset flag to prevent permanent sync breakage
          queueMicrotask(() => {
            skipSyncRef.current = false;
          });
        }
      },
      setSelection: (start: number, end: number) => {
        editor.update(() => {
          const root = $getRoot();
          const textContent = root.getTextContent();

          // Validate selection range
          if (start < 0 || end > textContent.length || start > end) {
            console.warn('Invalid selection range:', { start, end, length: textContent.length });
            return;
          }

          // Get the first paragraph or element node
          const firstChild = root.getFirstChild();
          if (!firstChild || !$isElementNode(firstChild)) {
            console.warn('No element node found in root');
            return;
          }

          // Get the text node inside the paragraph
          const firstTextNode = firstChild.getFirstChild();
          if (!firstTextNode || !$isTextNode(firstTextNode)) {
            console.warn('No text node found in first element');
            return;
          }

          // Create a range selection
          const selection = $createRangeSelection();

          // Set anchor (start of selection)
          selection.anchor.set(firstTextNode.getKey(), start, 'text');

          // Set focus (end of selection)
          selection.focus.set(firstTextNode.getKey(), end, 'text');

          // Apply the selection
          $setSelection(selection);
        });
      },
      focus: () => {
        editor.focus();
      },
      blur: () => {
        editor.blur();
      },
    });
    // skipSyncRef is intentionally excluded - it's a mutable ref that doesn't need to trigger re-runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, onRef]);

  return null;
}

export const LexicalChatInput = forwardRef<LexicalChatInputRef, LexicalChatInputProps>(
  ({ value, onChange, onSubmit, onPaste, placeholder = 'Type your message...', agents }, ref) => {
    const editorRefStore = useRef<LexicalChatInputRef | null>(null);
    const skipSyncRef = useRef<boolean>(false);

    // Expose the ref
    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        return editorRefStore.current?.getMarkdown() || '';
      },
      getSerializedValue: () => {
        return editorRefStore.current?.getSerializedValue() || '';
      },
      getMentions: () => {
        return editorRefStore.current?.getMentions() ?? [];
      },
      insertContent: (markdown: string) => {
        editorRefStore.current?.insertContent(markdown);
      },
      setSelection: (start: number, end: number) => {
        editorRefStore.current?.setSelection(start, end);
      },
      focus: () => {
        editorRefStore.current?.focus();
      },
      blur: () => {
        editorRefStore.current?.blur();
      },
    }));

    // Initial editor configuration - memoized to prevent recreating on every render
    const initialConfig = useMemo(
      () => ({
        namespace: 'ChatInput',
        theme: {
          text: {
            code: 'lexical-inline-code',
          },
          code: 'lexical-code-block',
          paragraph: 'lexical-paragraph',
          list: {
            ol: 'lexical-list-ol',
            ul: 'lexical-list-ul',
            listitem: 'lexical-list-listitem',
            nested: {
              listitem: 'lexical-list-nested-listitem',
            },
          },
          // Code highlighting theme - maps Prism token types to CSS classes
          codeHighlight: {
            atrule: 'token-atrule',
            attr: 'token-attr',
            boolean: 'token-boolean',
            builtin: 'token-builtin',
            cdata: 'token-cdata',
            char: 'token-char',
            class: 'token-class',
            'class-name': 'token-class-name',
            comment: 'token-comment',
            constant: 'token-constant',
            deleted: 'token-deleted',
            doctype: 'token-doctype',
            entity: 'token-entity',
            function: 'token-function',
            important: 'token-important',
            inserted: 'token-inserted',
            keyword: 'token-keyword',
            namespace: 'token-namespace',
            number: 'token-number',
            operator: 'token-operator',
            prolog: 'token-prolog',
            property: 'token-property',
            punctuation: 'token-punctuation',
            regex: 'token-regex',
            selector: 'token-selector',
            string: 'token-string',
            symbol: 'token-symbol',
            tag: 'token-tag',
            url: 'token-url',
            variable: 'token-variable',
          },
        },
        nodes: [CodeNode, CodeHighlightNode, BeautifulMentionNode, ListNode, ListItemNode],
        onError: (error: Error) => {
          console.error('Lexical error:', error);

          // Provide user feedback
          toast.error('Editor error occurred. Please refresh if issues persist.', {
            description: error.message,
          });
        },
      }),
      []
    ); // Empty deps array - config never changes

    // Convert agent data for mentions plugin
    // Items should just be strings (the plugin will handle the rest)
    // Memoized to prevent re-processing the agent list on every render
    const agentMentionItems = useMemo(
      () => agents.flatMap(agent => agent.triggerWords.map(word => word.replace('@', ''))),
      [agents]
    );

    // Handle editor changes - export plain text for display/sync
    // Wrapped in useCallback to prevent unnecessary re-renders of OnChangePlugin
    const handleEditorChange = useCallback(
      (editorState: EditorState, editor: LexicalEditor) => {
        editorState.read(() => {
          const root = $getRoot();
          const textContent = root.getTextContent();
          onChange(textContent);
        });
      },
      [onChange]
    );

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <div className="lexical-chat-input-container">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                data-testid="lexical-chat-input-container"
                className="lexical-chat-input"
                role="textbox"
                aria-label="Chat message input"
                aria-placeholder={placeholder}
                aria-multiline="true"
                placeholder={<div className="lexical-placeholder">{placeholder}</div>}
              />
            }
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          {/* Core Lexical plugins - stable, no error boundary needed */}
          <HistoryPlugin />
          <OnChangePlugin onChange={handleEditorChange} />

          {/* Sync external value changes to editor */}
          <PluginErrorBoundary pluginName="SyncValuePlugin">
            <SyncValuePlugin value={value} skipSyncRef={skipSyncRef} />
          </PluginErrorBoundary>

          {/* Submit on Enter plugin */}
          {onSubmit && (
            <PluginErrorBoundary pluginName="SubmitOnEnterPlugin">
              <SubmitOnEnterPlugin onSubmit={onSubmit} />
            </PluginErrorBoundary>
          )}

          {/* Paste handler plugin */}
          {onPaste && (
            <PluginErrorBoundary pluginName="PasteHandlerPlugin">
              <PasteHandlerPlugin onPaste={onPaste} />
            </PluginErrorBoundary>
          )}

          {/* Custom inline code plugin for WYSIWYG with hidden backticks */}
          <PluginErrorBoundary pluginName="InlineCodePlugin">
            <InlineCodePlugin />
          </PluginErrorBoundary>

          {/* Code block plugin for WYSIWYG */}
          <PluginErrorBoundary pluginName="CodeBlockPlugin">
            <CodeBlockPlugin />
          </PluginErrorBoundary>

          {/* Code syntax highlighting plugin */}
          <PluginErrorBoundary pluginName="CodeHighlightPlugin">
            <CodeHighlightPlugin />
          </PluginErrorBoundary>

          {/* List support plugin - official Lexical plugin */}
          <ListPlugin />

          {/* List Tab/Shift+Tab indentation handler */}
          <PluginErrorBoundary pluginName="ListTabHandlerPlugin">
            <ListTabHandlerPlugin />
          </PluginErrorBoundary>

          {/* Custom list markdown shortcuts (- for bullet, 1. for numbered) - works anywhere in document */}
          <PluginErrorBoundary pluginName="ListMarkdownPlugin">
            <ListMarkdownPlugin />
          </PluginErrorBoundary>

          {/* Markdown shortcuts for inline code only (lists handled by custom plugin above) */}
          <MarkdownShortcutPlugin transformers={[CODE, INLINE_CODE]} />

          {/* Beautiful Mentions Plugin for @mentions - third-party library, already stable */}
          <BeautifulMentionsPlugin
            items={{
              '@': agentMentionItems,
            }}
            menuAnchorClassName="mentions-menu-anchor"
            menuComponent={CustomMentionsMenu}
          />

          {/* Fix double space after mention selection */}
          <PluginErrorBoundary pluginName="MentionsSpaceHandlerPlugin">
            <MentionsSpaceHandlerPlugin />
          </PluginErrorBoundary>

          {/* Fix mentions menu positioning */}
          <PluginErrorBoundary pluginName="MentionsMenuPositionPlugin">
            <MentionsMenuPositionPlugin />
          </PluginErrorBoundary>

          {/* Editor ref plugin - exposes getMarkdown, insertContent, setSelection, and focus methods */}
          <PluginErrorBoundary pluginName="EditorRefPlugin">
            <EditorRefPlugin onRef={ref => (editorRefStore.current = ref)} skipSyncRef={skipSyncRef} />
          </PluginErrorBoundary>
        </div>
      </LexicalComposer>
    );
  }
);

LexicalChatInput.displayName = 'LexicalChatInput';
