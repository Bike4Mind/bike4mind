import { Box, Stack, Typography } from '@mui/joy';
import { PropsWithChildren } from 'react';
import { alpha } from '@mui/system';
import { ContextHelpButton } from '@client/app/components/help';
import { panelSurfaceSx } from './settingsStyles';

const SectionContainer = ({
  children,
  title,
  subtitle,
  action,
  helpId,
  helpTooltip,
  titleActionStyles = { sx: {} },
}: PropsWithChildren<{
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  helpId?: string;
  helpTooltip?: string;
  titleActionStyles?: {
    sx?: object;
  };
}>) => {
  return (
    <Box
      className="section-container"
      sx={theme => ({
        ...panelSurfaceSx(theme),
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        gap: '1.875rem',
        position: 'relative',
      })}
    >
      {(!!title || !!subtitle) && (
        <Box className="section-container-header" sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {(title || action) && (
            <Box
              className="section-container-title-action"
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                flexWrap: 'wrap',
                gap: '12px',
                ...titleActionStyles.sx,
              }}
            >
              {title && (
                <Stack
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  className="section-container-title"
                  sx={{ minWidth: 0 }}
                >
                  {typeof title === 'string' ? <Typography level="title-md">{title}</Typography> : title}
                  {helpId && <ContextHelpButton helpId={helpId} tooltipText={helpTooltip || 'Learn more'} size="sm" />}
                </Stack>
              )}
              {action && (
                <Box
                  className="section-container-action"
                  sx={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem', minWidth: 0 }}
                >
                  {action}
                </Box>
              )}
            </Box>
          )}

          {subtitle && (
            <Box className="section-container-subtitle">
              {typeof subtitle === 'string' ? (
                <Typography
                  level="body-sm"
                  maxWidth="540px"
                  sx={{
                    color: theme =>
                      theme.palette.mode === 'light'
                        ? alpha(theme.palette.text.primary, 0.75)
                        : alpha(theme.palette.text.primary, 0.5),
                  }}
                >
                  {subtitle}
                </Typography>
              ) : (
                subtitle
              )}
            </Box>
          )}
        </Box>
      )}

      {children}
    </Box>
  );
};
export default SectionContainer;
