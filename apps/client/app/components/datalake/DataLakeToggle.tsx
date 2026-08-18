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
        // Match the sidebar's own fill (background.surface2) so the pill reads as chrome, not a CTA.
        // Set background-color directly AND override the outlined variant's CSS vars (default
        // transparent) so the fill wins regardless of Joy's var(--variant-outlinedBg) rule.
        sx={theme => ({
          height: 32,
          minHeight: 32,
          fontWeight: 400,
          fontSize: 14,
          px: '12px',
          borderRadius: '6px',
          backgroundColor: theme.palette.background.surface2,
          '--variant-outlinedBg': theme.palette.background.surface2,
          '--variant-outlinedHoverBg': theme.palette.notebooklist.hoverBg,
          '--variant-outlinedActiveBg': theme.palette.notebooklist.hoverBg,
        })}
      >
        Data Lakes
      </Button>
    </Tooltip>
  );
}
