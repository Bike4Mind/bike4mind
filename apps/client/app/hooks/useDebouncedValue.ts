import debounce from 'lodash/debounce';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface UseDebounceValueResult<T> {
  value: T;
  debouncedValue: T;
  setValue: (value: T) => void;
  /** Sets both values at once and drops any pending update, for an explicit reset that must not lag. */
  setValueImmediately: (value: T) => void;
}

export function useDebounceValue<T>(initialValue: T, delay: number = 300): UseDebounceValueResult<T> {
  const [value, setValue] = useState<T>(initialValue);
  const [debouncedValue, setDebouncedValue] = useState<T>(initialValue);

  const debouncedSetValue = useMemo(
    () =>
      debounce((newValue: T) => {
        setDebouncedValue(newValue);
      }, delay),
    [delay]
  );

  useEffect(() => {
    debouncedSetValue(value);
    return () => {
      debouncedSetValue.cancel();
    };
  }, [value, debouncedSetValue]);

  const setValueImmediately = useCallback(
    (newValue: T) => {
      debouncedSetValue.cancel();
      setValue(newValue);
      setDebouncedValue(newValue);
    },
    [debouncedSetValue]
  );

  return { value, debouncedValue, setValue, setValueImmediately };
}
