import { debounce } from 'lodash';
import { useCallback, useMemo } from 'react';

export const useDetectScrollBottom = (enabled: boolean, callback: () => void) => {
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const element = e.target as HTMLDivElement;

      const value = Math.floor(element.scrollHeight - element.scrollTop);
      if (value + 2 >= element.clientHeight && value - 2 <= element.clientHeight) {
        callback();
      }
    },
    [callback, enabled]
  );

  return useMemo(() => debounce(handleScroll, 300), [handleScroll]);
};
