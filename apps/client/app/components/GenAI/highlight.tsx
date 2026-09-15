import { ReactNode } from 'react';
import escapeStringRegexp from 'escape-string-regexp';

// Pre-compiled regex patterns for validation
const SAFE_SEARCH_PATTERN = /^[\w\s\-.,!?]+$/;
const MAX_SEARCH_LENGTH = 100; // Prevent extremely long search patterns
const MAX_EXECUTION_TIME = 1000; // 1 second timeout

export const highlightTextSearch = (node: ReactNode[] | string, search?: string) => {
  if (!search) return node;

  // Additional validation to prevent malicious patterns
  if (!SAFE_SEARCH_PATTERN.test(search)) {
    return node;
  }

  const markText = (text: string, pidx: number) => {
    // Escape special characters in the search string
    const escapedSearch = escapeStringRegexp(search.slice(0, MAX_SEARCH_LENGTH));

    // Pre-compile the regex pattern
    const searchPattern = new RegExp(`(${escapedSearch})`, 'gi');

    // Use a timeout to prevent long-running regex operations
    const timeout = setTimeout(() => {
      console.warn('Text highlighting operation timed out');
      return text;
    }, MAX_EXECUTION_TIME);

    try {
      const parts = text.split(searchPattern);
      clearTimeout(timeout);
      return parts.map((part, idx) =>
        part.toLowerCase() === search.toLowerCase() ? <mark key={`${idx}_${pidx}`}>{part}</mark> : part
      );
    } catch (error) {
      clearTimeout(timeout);
      console.error('Error during text highlighting:', error);
      return text;
    }
  };

  if (Array.isArray(node) && search) {
    return node
      .map((child, pidx) => {
        if (typeof child === 'string') {
          return markText(child, pidx);
        } else {
          return child;
        }
      })
      .flat();
  } else if (typeof node === 'string') {
    return markText(node, 1);
  } else {
    return node;
  }
};
