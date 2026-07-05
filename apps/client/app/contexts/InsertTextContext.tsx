import React, { ReactNode, createContext, useContext, FC } from 'react';

type InsertTextContextType = {
  insertText: (text: string, callback?: (text: string) => void) => void;
};

const InsertTextContext = createContext<InsertTextContextType | undefined>(undefined);

export const useInsertText = (): InsertTextContextType => {
  const context = useContext(InsertTextContext);
  if (!context) {
    throw new Error('useInsertText must be used within InsertTextProvider');
  }
  return context;
};

interface InsertTextProviderProps {
  value: InsertTextContextType;
  children: ReactNode;
}

export const InsertTextProvider: FC<InsertTextProviderProps> = ({ children, value }) => {
  return <InsertTextContext.Provider value={value}>{children}</InsertTextContext.Provider>;
};
