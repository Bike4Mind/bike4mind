import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { Box, CssBaseline, GlobalStyles, Stack, Typography, Input, FormControl, FormLabel } from '@mui/joy';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { adminPalette } from '../app/utils/themes/admin';
import { adminSkinComponents, adminSkinGlobalStyles } from '../app/utils/themes/customizations/adminSkin';
import { adminPageFrame } from '../app/components/admin/shared/adminStyles';
import DlqReplayTab from '../app/components/admin/DlqReplayTab';
import AiOperationsTab from '../app/components/admin/AiOperationsTab';
import { MorningBriefCard } from '../app/components/admin/MorningBriefCard';
import FeedbackCloseDialog from '../app/components/admin/Feedback/FeedbackCloseDialog';
import FeedbackHistory from '../app/components/admin/Feedback/FeedbackHistory';
import { SettingFieldRow } from '../app/components/admin/shared/SettingFieldRow';
import { SettingsSection } from '../app/components/admin/shared/SettingsSection';
import { AdminPageHeader } from '../app/components/admin/shared/AdminPageHeader';
import { ADMIN_AI_FEATURES } from './common';
const page = new URLSearchParams(location.search).get('page') ?? 'dlq';
const config = {
  enabled: true,
  monthlyCapUsd: 5,
  features: Object.fromEntries(
    ADMIN_AI_FEATURES.map(feature => [feature, { mode: 'shadow', dailyBudgetUsd: 1, maxCallsPerDay: 100 }])
  ),
};
window.fetch = async (_input, init) => {
  if (init?.method && init.method !== 'GET') throw new Error('Visual fixture: writes are disabled');
  return new Response(
    JSON.stringify({
      config,
      monthUsd: 4.2,
      budgetState: 'warning',
      classes: [],
      recent: [],
      coverage: 'Deterministic visual fixture. Unknown costs excluded.',
      features: ADMIN_AI_FEATURES.map(feature => ({
        feature,
        mode: 'shadow',
        todayUsd: 0.05,
        monthUsd: 0.7,
        callsToday: 8,
        unknownCostAttempts: 0,
        skips: [{ reason: 'budget', count: 2 }],
        accepted7: 19,
        overridden7: 1,
        accepted30: 98,
        overridden30: 2,
      })),
    })
  );
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Content() {
  if (page === 'ai') return <AiOperationsTab />;
  if (page === 'brief')
    return (
      <Stack gap={3}>
        <AdminPageHeader title="Dashboard" />
        <MorningBriefCard />
      </Stack>
    );
  if (page === 'feedback-close') return <FeedbackCloseDialog onClose={() => {}} onConfirm={async () => {}} />;
  if (page === 'feedback-history')
    return (
      <Stack gap={3}>
        <AdminPageHeader title="Feedback history" />
        <FeedbackHistory id="fixture" />
      </Stack>
    );
  if (page === 'setting-row')
    return (
      <Stack gap={3}>
        <AdminPageHeader
          title="Settings row primitive"
          description="Partial component fixture; not an Admin settings or Growth and pricing page."
        />
        <SettingsSection>
          {['Monthly budget', 'Daily call cap', 'Default policy'].map(label => (
            <SettingFieldRow key={label}>
              <FormControl>
                <FormLabel>{label}</FormLabel>
                <Input defaultValue="100" />
                <Typography level="body-xs">Current: 100</Typography>
              </FormControl>
            </SettingFieldRow>
          ))}
        </SettingsSection>
      </Stack>
    );
  return <DlqReplayTab />;
}
const mode = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
const theme = extendTheme({
  colorSchemes: { light: { palette: { admin: adminPalette.light } }, dark: { palette: { admin: adminPalette.dark } } },
  components: adminSkinComponents,
});
localStorage.setItem('joy-mode', mode);
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <CssVarsProvider theme={theme} defaultMode={mode}>
      <CssBaseline />
      <GlobalStyles styles={adminSkinGlobalStyles(theme)} />
      <Box data-admin-surface="" sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', minHeight: '100vh' }}>
        <Box sx={{ ...adminPageFrame }}>
          <Content />
        </Box>
      </Box>
    </CssVarsProvider>
  </QueryClientProvider>
);
