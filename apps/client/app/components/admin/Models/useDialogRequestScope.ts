import { useLayoutEffect, useRef } from 'react';

/** Capture ownership before dispatch; only the same mounted dialog target may settle its UI. */
export function useDialogRequestScope(scope: string): () => () => boolean {
  const current = useRef<object | null>(null);
  useLayoutEffect(() => {
    const token = {};
    current.current = token;
    return () => {
      current.current = null;
    };
  }, [scope]);
  return () => {
    const token = current.current;
    return () => token !== null && current.current === token;
  };
}
