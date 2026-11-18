import React, { createContext, useContext, useLayoutEffect, useState } from 'react';
import { formatWithOptions } from 'node:util';

const OutputContext = createContext('');
const OUTPUT_LIMIT = 64 * 1024;
const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export function FullscreenOutput({
  children,
  onOutput,
}: {
  children: React.ReactNode;
  onOutput: (output: string) => void;
}) {
  const [output, setOutput] = useState('');
  useLayoutEffect(() => {
    let captured = '';
    const originals = METHODS.map(method => [method, console[method]] as const);
    for (const method of METHODS) {
      console[method] = (...args: unknown[]) => {
        const text = formatWithOptions({ colors: false }, ...args);
        captured = `${captured}${captured ? '\n' : ''}${text}`.slice(-OUTPUT_LIMIT);
        onOutput(captured);
        setOutput(captured);
      };
    }
    return () => {
      for (const [method, original] of originals) console[method] = original;
    };
  }, [onOutput]);
  return <OutputContext.Provider value={output}>{children}</OutputContext.Provider>;
}

export function useFullscreenOutput() {
  return useContext(OutputContext);
}
