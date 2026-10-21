import React, { createContext, useContext } from 'react';

/**
 * Read-only mode for a rendered conversation: no composer, no drop zone, and no message
 * action that writes or sends. Copy, tool details, diagnostics and downloads stay.
 * SessionContainer's `readOnly` prop provides it; a host page may also wrap its tree in
 * the provider directly. Defaults to false, so every existing caller is unaffected.
 */
const SessionReadOnlyContext = createContext(false);

export const SessionReadOnlyProvider: React.FC<{ readOnly: boolean; children: React.ReactNode }> = ({
  readOnly,
  children,
}) => <SessionReadOnlyContext.Provider value={readOnly}>{children}</SessionReadOnlyContext.Provider>;

export const useSessionReadOnly = (): boolean => useContext(SessionReadOnlyContext);
