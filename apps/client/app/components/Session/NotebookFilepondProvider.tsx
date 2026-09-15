import { createContext, PropsWithChildren, useContext, useRef } from 'react';
import { FilePond } from 'react-filepond';

export const NotebookFilepondContext = createContext<React.RefObject<FilePond | null> | undefined>(undefined);

export const NotebookFilepondProvider = ({ children }: PropsWithChildren) => {
  const filepondRef = useRef<FilePond>(null);
  return <NotebookFilepondContext.Provider value={filepondRef}>{children}</NotebookFilepondContext.Provider>;
};

export function useNotebookFilepond() {
  const context = useContext(NotebookFilepondContext);
  if (context === undefined) {
    throw new Error('useNotebookFilepond must be used within a NotebookFilepondProvider');
  }

  return context;
}
