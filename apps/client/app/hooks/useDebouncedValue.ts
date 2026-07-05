import debounce from 'lodash/debounce';
import { useEffect, useMemo, useState } from 'react';

interface UseDebounceValueResult<T> {
  value: T;
  debouncedValue: T;
  setValue: (value: T) => void;
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

  return { value, debouncedValue, setValue };
}
