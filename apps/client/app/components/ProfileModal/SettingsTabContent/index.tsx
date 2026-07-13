import { useUser } from '@client/app/contexts/UserContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import SettingsIcon from '@mui/icons-material/Settings';
import { Box, LinearProgress, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import { styled } from '@mui/system';
import { useNavigate, useSearch } from '@tanstack/react-router';
import dynamic from 'next/dynamic';
import { useTranslation } from 'react-i18next';
import GeneralSettingsTab from './GeneralSettingsTab';

const EmailInboxTabContent = dynamic(() => import('@client/app/components/ProfileModal/EmailInboxTabContent'), {
  ssr: false,
  loading: () => <LinearProgress />,
});
const MementosTabContent = dynamic(() => import('@client/app/components/ProfileModal/MementosTabContent'), {
  ssr: false,
  loading: () => <LinearProgress />,
});
const SystemPromptsTab = dynamic(
  () => import('@client/app/components/ProfileModal/SystemPromptsTab').then(m => m.SystemPromptsTab),
  { ssr: false, loading: () => <LinearProgress /> }
);

export enum SettingsSubTab {
  General = 'general',
  CustomInstructions = 'custom-instructions',
  EmailInbox = 'email-inbox',
  Mementos = 'mementos',
}

/**
 * Settings is a sub-tabbed container. It folds in surfaces that used to be
 * top-level Profile tabs - personal Custom Instructions (user-facing system
 * prompts), Email Inbox, and the flag-gated Mementos - so the top strip stays
 * short. The sub-tab is driven by the `?subtab=` search param so each panel
 * remains deep-linkable; an absent param resolves to General, which preserves
 * the existing `?section=security` MFA deep link.
 */
const SettingsTabContent = () => {
  const { currentUser } = useUser();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { subtab?: string };
  const { t } = useTranslation();

  // Gate Mementos through the shared feature hook so the admin `EnableMementos`
  // gate is respected (not just the raw user preference), and keep the sub-tab out
  // of the tree until both admin + user settings hydrate to avoid a flash.
  const { isFeatureEnabled, isLoading } = useFeatureEnabled();
  const enableMementos = !isLoading && isFeatureEnabled('enableMementos');
  const hasEmailIntegration = !!currentUser?.platformEmailAddress;

  // Fall back to General when the requested sub-tab isn't actually rendered - e.g.
  // `?subtab=mementos` with the flag off (the legacy `?tab=mementos` redirect always
  // maps here) or a typo'd `?subtab=` - otherwise the controlled <Tabs> shows an
  // empty strip with no panel.
  // Keep this set in sync with the <StyledSubTab> entries in <TabList> below -
  // a rendered sub-tab missing here silently falls back to General.
  const renderedSubTabs = new Set<string>([
    SettingsSubTab.General,
    SettingsSubTab.CustomInstructions,
    ...(hasEmailIntegration ? [SettingsSubTab.EmailInbox] : []),
    ...(enableMementos ? [SettingsSubTab.Mementos] : []),
  ]);
  const requestedSubTab = search?.subtab || SettingsSubTab.General;
  const activeSubTab = renderedSubTabs.has(requestedSubTab) ? requestedSubTab : SettingsSubTab.General;

  return (
    <Tabs
      aria-label="Settings sub-tabs"
      value={activeSubTab}
      onChange={(_, subtab) => {
        navigate({
          to: '/profile',
          search: { tab: 'settings', subtab: String(subtab ?? SettingsSubTab.General) },
          replace: true,
        });
      }}
    >
      <TabList data-testid="settings-subtablist" sx={{ mb: 1 }}>
        <StyledSubTab data-testid="settings-subtab-general" value={SettingsSubTab.General}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <SettingsIcon sx={{ fontSize: '16px' }} />
            <Typography sx={{ display: { xs: 'none', sm: 'block' } }}>General</Typography>
          </Box>
        </StyledSubTab>

        <StyledSubTab data-testid="settings-subtab-custom-instructions" value={SettingsSubTab.CustomInstructions}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <AutoFixHighIcon sx={{ fontSize: '16px' }} />
            <Typography sx={{ display: { xs: 'none', sm: 'block' } }}>{t('instructions.title')}</Typography>
          </Box>
        </StyledSubTab>

        {hasEmailIntegration && (
          <StyledSubTab data-testid="settings-subtab-email-inbox" value={SettingsSubTab.EmailInbox}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <MailOutlineIcon sx={{ fontSize: '16px' }} />
              <Typography sx={{ display: { xs: 'none', sm: 'block' } }}>Email Inbox</Typography>
            </Box>
          </StyledSubTab>
        )}

        {enableMementos && (
          <StyledSubTab data-testid="settings-subtab-mementos" value={SettingsSubTab.Mementos}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <AccessTimeIcon sx={{ fontSize: '16px' }} />
              <Typography sx={{ display: { xs: 'none', sm: 'block' } }}>{t('mementos.title')}</Typography>
            </Box>
          </StyledSubTab>
        )}
      </TabList>

      <StyledSubTabPanel value={SettingsSubTab.General}>
        {activeSubTab === SettingsSubTab.General && <GeneralSettingsTab />}
      </StyledSubTabPanel>

      <StyledSubTabPanel value={SettingsSubTab.CustomInstructions}>
        {activeSubTab === SettingsSubTab.CustomInstructions && currentUser && <SystemPromptsTab user={currentUser} />}
      </StyledSubTabPanel>

      {hasEmailIntegration && (
        <StyledSubTabPanel value={SettingsSubTab.EmailInbox}>
          {activeSubTab === SettingsSubTab.EmailInbox && <EmailInboxTabContent />}
        </StyledSubTabPanel>
      )}

      {enableMementos && (
        <StyledSubTabPanel value={SettingsSubTab.Mementos}>
          {activeSubTab === SettingsSubTab.Mementos && <MementosTabContent />}
        </StyledSubTabPanel>
      )}
    </Tabs>
  );
};

const StyledSubTabPanel = styled(TabPanel)({
  padding: '8px 0 0',
});

const StyledSubTab = styled(Tab)(({ theme }) => ({
  '& .MuiTypography-root': { opacity: 0.7 },
  '& .MuiSvgIcon-root': { opacity: 0.5 },
  '&:hover:not([aria-selected="true"])': {
    '& .MuiTypography-root': { opacity: 1 },
    '& .MuiSvgIcon-root': { opacity: 1 },
  },
  '&[aria-selected="true"] .MuiTypography-root': { opacity: 1 },
  '&[aria-selected="true"] .MuiSvgIcon-root': { opacity: 1 },
}));

export default SettingsTabContent;
