import React, { useEffect, useRef, useState } from 'react';
import { Text, useInput, usePaste } from 'ink';
import { MAX_PASTE_SIZE, PASTE_LINE_THRESHOLD } from '../config/constants.js';

interface CustomTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onClearScreen?: () => void;
  onPaste?: (content: string) => void;
  pasteIndicator?: string | null;
  placeholder?: string;
  showCursor?: boolean;
  disabled?: boolean;
}

/**
 * Custom text input component with readline-style keyboard shortcuts
 * Built to replace ink-text-input which doesn't support these shortcuts
 */
export function CustomTextInput({
  value,
  onChange,
  onSubmit,
  onPaste,
  pasteIndicator,
  placeholder = '',
  showCursor = true,
  disabled = false,
}: CustomTextInputProps) {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const prevValueRef = useRef(value);
  // Track whether the latest value change originated from this component's own input handling
  const internalChangeRef = useRef(false);

  // Wrapper that marks value changes as internal so the sync effect preserves cursor position
  const emitChange = (newValue: string) => {
    internalChangeRef.current = true;
    onChange(newValue);
  };

  // Sync cursor position when value changes externally (e.g., history navigation)
  // Skip when the change originated from this component's own onChange (internal edit)
  useEffect(() => {
    if (value !== prevValueRef.current) {
      if (internalChangeRef.current) {
        // Change came from our own input handler - cursor is already positioned correctly
        internalChangeRef.current = false;
      } else {
        // External change (history navigation, prefill, etc.) - move cursor to end
        setCursorOffset(value.length);
      }
      prevValueRef.current = value;
    }
  }, [value]);

  // Helper functions for word navigation
  const findPreviousWordBoundary = (text: string, position: number): number => {
    // Move back from current position, skip any whitespace first
    let pos = position;
    while (pos > 0 && /\s/.test(text[pos - 1])) {
      pos--;
    }
    // Then move back to the start of the word
    while (pos > 0 && !/\s/.test(text[pos - 1])) {
      pos--;
    }
    return pos;
  };

  const findNextWordBoundary = (text: string, position: number): number => {
    // Move forward from current position, skip current word
    let pos = position;
    while (pos < text.length && !/\s/.test(text[pos])) {
      pos++;
    }
    // Then skip any whitespace
    while (pos < text.length && /\s/.test(text[pos])) {
      pos++;
    }
    return pos;
  };

  // Bracketed paste handling (ink v7). Pasted text arrives as a single string
  // and is never forwarded to useInput, so we own paste UX from here.
  // - Long pastes (>= PASTE_LINE_THRESHOLD lines): hand off to onPaste so the
  //   parent can show a paste indicator instead of dumping the content.
  // - Short pastes: insert at the cursor like normal typing.
  usePaste(
    text => {
      const truncated = text.length > MAX_PASTE_SIZE ? text.slice(0, MAX_PASTE_SIZE) : text;
      const normalized = truncated.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lineCount = normalized.split('\n').length;

      if (lineCount >= PASTE_LINE_THRESHOLD && onPaste) {
        onPaste(normalized);
        return;
      }

      if (pasteIndicator) {
        emitChange(normalized);
        setCursorOffset(normalized.length);
        return;
      }

      const newValue = value.slice(0, cursorOffset) + normalized + value.slice(cursorOffset);
      emitChange(newValue);
      setCursorOffset(cursorOffset + normalized.length);
    },
    { isActive: !disabled }
  );

  // Handle input keys
  useInput(
    (input, key) => {
      // Handle Enter - submit (plain Enter only, no modifiers)
      if (key.return && !key.meta && !key.shift) {
        // Backslash-escape: if input ends with `\`, replace it with a newline instead of submitting
        if (value.length > 0 && value[cursorOffset - 1] === '\\') {
          const newValue = value.slice(0, cursorOffset - 1) + '\n' + value.slice(cursorOffset);
          emitChange(newValue);
          // Cursor replaces the `\` with `\n`, net position stays the same
          setCursorOffset(cursorOffset);
          return;
        }
        onSubmit(value);
        return;
      }

      // Insert newline on modified Enter:
      // - Shift+Enter: works in Kitty keyboard protocol terminals
      // - Option/Alt+Enter: works in standard terminals (sends \x1b\r, detected as meta)
      // Standard terminals can't distinguish Shift+Enter from Enter (both send \r),
      // so Option+Enter is the reliable cross-terminal alternative.
      if (key.return && (key.shift || key.meta)) {
        const newValue = value.slice(0, cursorOffset) + '\n' + value.slice(cursorOffset);
        emitChange(newValue);
        setCursorOffset(cursorOffset + 1);
        return;
      }

      // Mac-style shortcuts with Cmd (meta) key
      if (key.meta && !key.ctrl) {
        if (key.shift) {
          // Cmd+Shift+Left/Right: Word navigation
          if (key.leftArrow) {
            // Cmd+Shift+Left: Jump to beginning of previous word
            const newPos = findPreviousWordBoundary(value, cursorOffset);
            setCursorOffset(newPos);
            return;
          }
          if (key.rightArrow) {
            // Cmd+Shift+Right: Jump to end of next word
            const newPos = findNextWordBoundary(value, cursorOffset);
            setCursorOffset(newPos);
            return;
          }
          if (key.backspace) {
            // Cmd+Shift+Backspace: Delete word before cursor
            const beforeCursor = value.slice(0, cursorOffset);
            const afterCursor = value.slice(cursorOffset);
            const newPos = findPreviousWordBoundary(beforeCursor, beforeCursor.length);
            const newValue = beforeCursor.slice(0, newPos) + afterCursor;
            emitChange(newValue);
            setCursorOffset(newPos);
            return;
          }
          if (key.delete) {
            // Cmd+Shift+Delete: Delete word after cursor
            const beforeCursor = value.slice(0, cursorOffset);
            const afterCursor = value.slice(cursorOffset);
            const newPos = findNextWordBoundary(afterCursor, 0);
            const newValue = beforeCursor + afterCursor.slice(newPos);
            emitChange(newValue);
            return;
          }
        } else {
          // Cmd+Left/Right without Shift: Line navigation
          if (key.leftArrow) {
            // Cmd+Left: Jump to beginning of line
            setCursorOffset(0);
            return;
          }
          if (key.rightArrow) {
            // Cmd+Right: Jump to end of line
            setCursorOffset(value.length);
            return;
          }
          if (key.backspace) {
            // Cmd+Backspace: Delete to beginning of line
            const afterCursor = value.slice(cursorOffset);
            emitChange(afterCursor);
            setCursorOffset(0);
            return;
          }
          if (key.delete) {
            // Cmd+Delete: Delete to end of line
            emitChange(value.slice(0, cursorOffset));
            return;
          }
        }
      }

      // Home/End keys
      if (key.home) {
        setCursorOffset(0);
        return;
      }
      if (key.end) {
        setCursorOffset(value.length);
        return;
      }

      // Readline-style shortcuts (Ctrl+...)
      if (key.ctrl) {
        switch (input) {
          case 'u':
            // Ctrl+U: Clear current line (where cursor is)
            {
              const lines = value.split('\n');
              let currentLineStart = 0;
              let currentLineIndex = 0;
              let charCount = 0;

              // Find which line the cursor is on
              for (let i = 0; i < lines.length; i++) {
                const lineLength = lines[i].length;
                if (charCount + lineLength >= cursorOffset) {
                  currentLineIndex = i;
                  currentLineStart = charCount;
                  break;
                }
                charCount += lineLength + 1; // +1 for newline
              }

              // Remove the current line
              lines.splice(currentLineIndex, 1);
              const newValue = lines.join('\n');
              emitChange(newValue);

              // Set cursor to start of where the line was (or end if last line removed)
              setCursorOffset(Math.min(currentLineStart, newValue.length));
            }
            return;
          case 'k':
            // Ctrl+K: Clear from cursor to end of line (keep text before cursor)
            emitChange(value.slice(0, cursorOffset));
            return;
          case 'w':
            // Ctrl+W: Delete word before cursor
            {
              const beforeCursor = value.slice(0, cursorOffset);
              const afterCursor = value.slice(cursorOffset);
              const newPos = findPreviousWordBoundary(beforeCursor, beforeCursor.length);
              const newValue = beforeCursor.slice(0, newPos) + afterCursor;
              emitChange(newValue);
              setCursorOffset(newPos);
            }
            return;
          case 'a':
            // Ctrl+A: Move cursor to beginning
            setCursorOffset(0);
            return;
          case 'e':
            // Ctrl+E: Move cursor to end
            setCursorOffset(value.length);
            return;
          case 'l':
            // Ctrl+L: Clear screen
            emitChange('');
            return;
          case 'b':
            // Ctrl+B: Move cursor left (Emacs-style)
            setCursorOffset(Math.max(0, cursorOffset - 1));
            return;
          case 'f':
            // Ctrl+F: Move cursor right (Emacs-style)
            setCursorOffset(Math.min(value.length, cursorOffset + 1));
            return;
          case 'd':
            // Ctrl+D: Delete character at cursor (forward delete)
            if (cursorOffset < value.length) {
              const newValue = value.slice(0, cursorOffset) + value.slice(cursorOffset + 1);
              emitChange(newValue);
            }
            return;
          case 'h':
            // Ctrl+H: Backspace (Emacs-style)
            if (cursorOffset > 0) {
              const newValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
              emitChange(newValue);
              setCursorOffset(cursorOffset - 1);
            }
            return;
        }
      }

      // Handle backspace (backward delete)
      if (key.backspace) {
        if (pasteIndicator) {
          emitChange('');
          setCursorOffset(0);
          return;
        }
        if (cursorOffset > 0) {
          const newValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          emitChange(newValue);
          setCursorOffset(cursorOffset - 1);
        }
        return;
      }

      // Handle delete (forward delete)
      if (key.delete) {
        if (pasteIndicator) {
          emitChange('');
          setCursorOffset(0);
          return;
        }
        if (cursorOffset < value.length) {
          const newValue = value.slice(0, cursorOffset) + value.slice(cursorOffset + 1);
          emitChange(newValue);
        }
        return;
      }

      // Handle arrow keys (basic left/right movement, without modifiers)
      if (key.leftArrow && !key.meta && !key.ctrl) {
        setCursorOffset(Math.max(0, cursorOffset - 1));
        return;
      }

      if (key.rightArrow && !key.meta && !key.ctrl) {
        setCursorOffset(Math.min(value.length, cursorOffset + 1));
        return;
      }

      // Handle regular character input (including pasted text)
      if (!key.ctrl && !key.meta && input.length > 0) {
        // Detect large paste (multi-char input with enough lines)
        if (input.length > 1 && onPaste) {
          const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          const lineCount = normalized.split('\n').length;
          if (lineCount >= PASTE_LINE_THRESHOLD) {
            onPaste(normalized);
            return;
          }
        }

        // If paste indicator is active, typing starts fresh (discard paste)
        if (pasteIndicator) {
          const sanitizedInput = input === '\r' ? '\n' : input;
          emitChange(sanitizedInput);
          setCursorOffset(sanitizedInput.length);
          return;
        }

        // If input is \r (carriage return), treat it as \n (newline)
        const sanitizedInput = input === '\r' ? '\n' : input;
        const newValue = value.slice(0, cursorOffset) + sanitizedInput + value.slice(cursorOffset);
        emitChange(newValue);
        // Move cursor by the length of inserted text (handles both single chars and paste)
        setCursorOffset(cursorOffset + sanitizedInput.length);
      }
    },
    { isActive: !disabled }
  );

  // Render paste indicator instead of raw content
  if (pasteIndicator) {
    return (
      <Text>
        <Text color="yellow">{pasteIndicator}</Text>
        {showCursor && <Text inverse> </Text>}
      </Text>
    );
  }

  // Render the input with cursor
  const hasValue = value.length > 0;

  if (!hasValue) {
    // Show placeholder with cursor when input is empty
    return (
      <Text>
        {showCursor ? (
          <>
            <Text inverse> </Text>
            <Text dimColor>{placeholder}</Text>
          </>
        ) : (
          <Text dimColor>{placeholder}</Text>
        )}
      </Text>
    );
  }

  // Split text at cursor position for rendering
  const beforeCursor = value.slice(0, cursorOffset);
  const cursorChar = value[cursorOffset] || ' ';
  const afterCursor = value.slice(cursorOffset + 1);

  return (
    <Text>
      {beforeCursor}
      {showCursor && <Text inverse>{cursorChar}</Text>}
      {!showCursor && cursorChar}
      {afterCursor}
    </Text>
  );
}
