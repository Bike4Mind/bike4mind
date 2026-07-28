import Button from '@mui/joy/Button';
import Tooltip from '@mui/joy/Tooltip';
import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';
import useSetDataLakeMode from '@client/app/hooks/useSetDataLakeMode';

/**
 * Header pill that turns Data Lake mode ON for the current chat, grounding it in the user's
 * Data Lakes. Delegates store + session persistence to useSetDataLakeMode. Once mode is on the
 * pill is hidden - the in-tree close (X) button becomes the off-switch - so this only ever
 * enables. Rendered in both the main app (SessionTop) and the OptiHashi overlay header.
 */
export default function DataLakeToggle() {
  const { isFeatureEnabled } = useAdminSettingsCache();
  const enabled = useDataLakeMode(s => s.enabled);
  const setMode = useSetDataLakeMode();

  if (!isFeatureEnabled('EnableDataLakes')) return null;
  if (enabled) return null;

  return (
    <Tooltip title="Ground this chat in your Data Lakes" disableInteractive>
      <Button
        size="sm"
        variant="outlined"
        color="neutral"
        startDecorator={<WaterOutlinedIcon sx={{ fontSize: 18 }} />}
        onClick={() => setMode(true)}
        data-testid="datalake-mode-toggle"
        sx={{ height: 32, minHeight: 32, fontWeight: 400, fontSize: 14, px: '12px', borderRadius: '6px' }}
      >
        Data Lakes
      </Button>
    </Tooltip>
  );
}
