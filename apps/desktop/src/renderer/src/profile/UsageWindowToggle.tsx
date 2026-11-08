import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import type { UsageWindowId } from '@shared/usage';
import { WINDOW_LABELS } from './usageView';

const WINDOWS: UsageWindowId[] = ['last-24-hours', 'last-30-days'];

export function UsageWindowToggle({
  value,
  onChange,
}: {
  value: UsageWindowId;
  onChange: (next: UsageWindowId) => void;
}) {
  return (
    <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} data-testid="profile-window-group">
      {WINDOWS.map(id => (
        <Button
          key={id}
          size="sm"
          variant={id === value ? 'solid' : 'soft'}
          color="neutral"
          onClick={() => onChange(id)}
          data-testid="profile-window-btn"
          data-window={id}
          aria-pressed={id === value}
        >
          {WINDOW_LABELS[id]}
        </Button>
      ))}
    </Stack>
  );
}
