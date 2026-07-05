import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { Snackbar, SnackbarProps } from '@mui/joy';

interface SnackbarContextType {
  showSnackbar: (message: string, options?: { variant?: SnackbarProps['variant'] }) => void;
}

const SnackbarContext = createContext<SnackbarContextType | undefined>(undefined);

export const useSnackbar = () => {
  const context = useContext(SnackbarContext);
  if (!context) {
    throw new Error('useSnackbar must be used within a SnackbarProvider');
  }
  return context;
};

interface SnackbarProviderProps {
  children: React.ReactNode;
}

export const SnackbarProvider: React.FC<SnackbarProviderProps> = ({ children }) => {
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [variant, setVariant] = React.useState<SnackbarProps['variant']>('soft');

  const showSnackbar = useCallback((message: string, options?: { variant?: SnackbarProps['variant'] }) => {
    setMessage(message);
    setVariant(options?.variant || 'soft');
    setOpen(true);
  }, []);

  const contextValue = useMemo(() => ({ showSnackbar }), [showSnackbar]);

  return (
    <SnackbarContext.Provider value={contextValue}>
      {children}
      <Snackbar
        variant={variant}
        open={open}
        onClose={() => setOpen(false)}
        autoHideDuration={3000}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {message}
      </Snackbar>
    </SnackbarContext.Provider>
  );
};
