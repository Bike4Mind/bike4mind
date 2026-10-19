import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { Snackbar, SnackbarProps } from '@mui/joy';

interface SnackbarContextType {
  showSnackbar: (
    message: string,
    options?: { variant?: SnackbarProps['variant']; color?: SnackbarProps['color'] }
  ) => void;
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
  const [color, setColor] = React.useState<SnackbarProps['color']>('neutral');

  const showSnackbar = useCallback<SnackbarContextType['showSnackbar']>((message, options) => {
    setMessage(message);
    setVariant(options?.variant || 'soft');
    setColor(options?.color || 'neutral');
    setOpen(true);
  }, []);

  const contextValue = useMemo(() => ({ showSnackbar }), [showSnackbar]);

  return (
    <SnackbarContext.Provider value={contextValue}>
      {children}
      <Snackbar
        variant={variant}
        color={color}
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
