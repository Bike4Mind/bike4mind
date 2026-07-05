import { useState, useCallback, useMemo } from 'react';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { truncateMarkdown } from '@client/app/utils/truncateMarkdown';

interface UseContentTruncationOptions {
  content?: string;
  isEnabled?: boolean;
}

interface UseContentTruncationReturn {
  /** Whether the content exceeds maxVisibleLines and was truncated */
  needsTruncation: boolean;
  /** Whether the user has expanded to see full content */
  isExpanded: boolean;
  /** Toggle between expanded/collapsed state */
  toggleExpanded: () => void;
  /** The content to render - truncated markdown when collapsed, full content when expanded */
  displayContent: string;
}

/**
 * Hook for truncating markdown content by line count.
 *
 * JS-based truncation keeps the markdown syntax valid after the cut. Unlike
 * CSS clamping, it avoids rendering DOM nodes beyond the visible area.
 *
 * @param options - Configuration options
 * @returns Truncation state and the content to display
 */
export const useContentTruncation = ({
  content,
  isEnabled = true,
}: UseContentTruncationOptions): UseContentTruncationReturn => {
  const { settings } = useUserSettings();
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setIsExpanded(prev => !prev);
  }, []);

  const truncationResult = useMemo(() => {
    if (!content || !isEnabled || !settings.autoCollapseContent) {
      return {
        content: content || '',
        wasTruncated: false,
        originalLineCount: content?.split('\n').length || 0,
      };
    }

    return truncateMarkdown(content, {
      maxLines: settings.maxVisibleLines,
      ellipsis: true,
      ellipsisString: '\n\n...',
    });
  }, [content, isEnabled, settings.autoCollapseContent, settings.maxVisibleLines]);

  const displayContent = useMemo(() => {
    if (isExpanded || !truncationResult.wasTruncated) {
      return content || '';
    }
    return truncationResult.content;
  }, [content, isExpanded, truncationResult]);

  return {
    needsTruncation: truncationResult.wasTruncated,
    isExpanded,
    toggleExpanded,
    displayContent,
  };
};
