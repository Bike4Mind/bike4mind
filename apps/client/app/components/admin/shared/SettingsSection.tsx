import { Sheet, type SheetProps } from '@mui/joy';
import { adminSurface } from './adminStyles';

export function SettingsSection({ children, sx, ...props }: SheetProps) {
  return (
    <Sheet
      variant="outlined"
      {...props}
      sx={[{ ...adminSurface, p: 2, mb: 2 }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]}
    >
      {children}
    </Sheet>
  );
}
