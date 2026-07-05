import { Box, Typography, Button } from '@mui/joy';
import { AlertCircle } from 'lucide-react';

interface ModalErrorFallbackProps {
  error?: Error;
  onReset?: () => void;
}

/**
 * Optional Fallback UI for Modal Error Boundary
 *
 * Displays a user-friendly error message when modals fail to render.
 * This is optional - by default, the error boundary fails silently.
 *
 * Usage:
 * <ModalErrorBoundary fallback={<ModalErrorFallback />}>
 *   <ModalManager />
 * </ModalErrorBoundary>
 */
export default function ModalErrorFallback({ error, onReset }: ModalErrorFallbackProps) {
  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        maxWidth: 400,
        p: 2,
        backgroundColor: 'danger.softBg',
        borderRadius: 'md',
        border: '1px solid',
        borderColor: 'danger.outlinedBorder',
        boxShadow: 'sm',
        zIndex: 9999,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <AlertCircle size={20} style={{ color: 'var(--joy-palette-danger-500)', flexShrink: 0, marginTop: 2 }} />
        <Box sx={{ flex: 1 }}>
          <Typography level="title-sm" sx={{ color: 'danger.plainColor', mb: 0.5 }}>
            Notification System Error
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 1 }}>
            We encountered an issue loading notifications. This won&apos;t affect the rest of the application.
          </Typography>
          {error && process.env.NODE_ENV === 'development' && (
            <Typography level="body-xs" sx={{ color: 'text.tertiary', fontFamily: 'monospace', mb: 1 }}>
              {error.message}
            </Typography>
          )}
          {onReset && (
            <Button size="sm" variant="soft" color="danger" onClick={onReset}>
              Try Again
            </Button>
          )}
        </Box>
      </Box>
    </Box>
  );
}
