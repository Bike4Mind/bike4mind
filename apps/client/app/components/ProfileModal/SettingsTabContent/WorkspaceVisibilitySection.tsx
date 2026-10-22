import { Box, Grid, Switch, Typography } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import { useHiddenSurfaces } from '@client/app/hooks/useHiddenSurfaces';
import { useHideableWorkspaces } from '@client/app/hooks/useWorkspaceTargets';

/**
 * One "Show in sidebar" switch per hideable workspace the user can open. Renders nothing when there
 * is none, so a user without access never learns a workspace exists.
 */
const WorkspaceVisibilitySection = () => {
  const { t } = useTranslation();
  const workspaces = useHideableWorkspaces();
  const { isHidden, setHidden } = useHiddenSurfaces();

  if (workspaces.length === 0) return null;

  return (
    <SectionContainer
      title={t('settings.workspace_visibility.title')}
      subtitle={t('settings.workspace_visibility.subtitle')}
    >
      <Grid container spacing={2}>
        {workspaces.map(workspace => (
          <Grid key={workspace.id} xs={12} md={6}>
            <Box
              sx={theme => ({
                ...cardSurfaceSx(theme),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px',
                height: '100%',
              })}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
                  {workspace.label}
                </Typography>
                <Typography level="body-sm" sx={{ mt: 0.5 }}>
                  {t('settings.workspace_visibility.show_in_sidebar')}
                </Typography>
              </Box>
              <Switch
                checked={!isHidden(workspace.id)}
                onChange={e => setHidden(workspace.id, !e.target.checked)}
                slotProps={{ input: { 'aria-label': t('settings.workspace_visibility.show_in_sidebar') } }}
                data-testid={`settings-workspace-visibility-${workspace.id}-switch`}
              />
            </Box>
          </Grid>
        ))}
      </Grid>
    </SectionContainer>
  );
};

export default WorkspaceVisibilitySection;
