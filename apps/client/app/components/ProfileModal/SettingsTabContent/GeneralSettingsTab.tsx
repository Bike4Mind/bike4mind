import UploadImportHistoryModal from '@/app/components/ProfileModal/UploadImportHistoryModal';
import NotebookExportModal from '@/app/components/ProfileModal/NotebookExportModal';
import NotebookImportModal from '@/app/components/ProfileModal/NotebookImportModal';
import NotebookCurationModal from '@/app/components/ProfileModal/NotebookCurationModal';
import ImportHistoryJobsList from '@/app/components/ProfileModal/ImportHistoryJobsList';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useDeleteAllFiles } from '@client/app/hooks/data/fabFiles';
import { useDeleteAllSessions } from '@client/app/hooks/data/sessions';
import { useDownload } from '@client/app/hooks/useDownload';
import useToggle from '@client/app/hooks/useToggle';
import { CloudUpload } from '@mui/icons-material';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import { Button, Grid, Stack, Box, Modal, ModalDialog, ModalClose, Switch, Input } from '@mui/joy';
import axios from 'axios';
import { uploadFileToUrl } from '@client/app/utils/uploadFileToUrl';
import { toast } from 'sonner';

import { api } from '@client/app/contexts/ApiContext';
import HelpIcon from '@mui/icons-material/Help';
import { Typography } from '@mui/joy';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import LanguageSelector from '@client/app/components/LanguageSelector';
import { useTranslation } from 'react-i18next';
import VoicePreferenceSection from './VoicePreferenceSection';
import ActiveSessionsSection from './ActiveSessionsSection';
import ApprovedAppsSection from './ApprovedAppsSection';
import DocxTemplateSection from './DocxTemplateSection';
import { DeleteAllKnowledgeFilesConfirm, DeleteAllNotebooksConfirm } from './DeleteAllConfirmModals';
import ExperimentalFeatureToggle from '../ExperimentalFeatureToggle';
import MfaCard from './MfaCard';
import SettingsActionButton from './SettingsActionButton';
import { useExperimentalFeatureSettings, useSettingsFromServer } from '@client/app/hooks/data/settings';
import { useEffect, useRef, useState } from 'react';
import { useSearch } from '@tanstack/react-router';

const GeneralSettingsTab = () => {
  const { settings, updatePreferences } = useUserSettings();
  const { isLoading: serverSettingsLoading } = useSettingsFromServer();
  const { data: experimentalSettingsWithDefaults } = useExperimentalFeatureSettings();

  // Scroll the Security/MFA section into view when navigated here with
  // ?section=security (e.g. the admin "Login as User -> Set Up MFA" flow).
  const search = useSearch({ strict: false }) as { section?: string };
  const securitySectionRef = useRef<HTMLDivElement>(null);

  // Wait for server settings to resolve so the optional Beta Features section
  // above doesn't shift the target after we scroll, and defer a frame so the
  // lazy-loaded panel has committed its layout before we measure.
  useEffect(() => {
    if (search?.section !== 'security' || serverSettingsLoading) return;
    const frame = requestAnimationFrame(() => {
      securitySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [search?.section, serverSettingsLoading]);

  const { t } = useTranslation();

  // Check if any experimental features are enabled at server level (uses defaults)
  const hasExperimentalFeatures =
    experimentalSettingsWithDefaults?.some(setting => {
      const isExperimentalSetting = [
        'EnableQuestMaster',
        'EnableMementos',
        'EnableArtifacts',
        'EnableAgents',
        'EnableOllama',
        'EnableResearchEngine',
        'EnableRapidReply',
      ].includes(setting.settingName);
      const settingValue = setting.settingValue;
      const isEnabled =
        typeof settingValue === 'boolean' ? settingValue : settingValue === 'true' || settingValue === '1';
      return isExperimentalSetting && isEnabled;
    }) ?? false;

  const deleteAllSessions = useDeleteAllSessions({
    onSuccess: async () => {
      toggleDeleteAllSessionsModal(false);
      toast.success('All notebooks deleted');
    },
  });
  const deleteAllFiles = useDeleteAllFiles({
    onSuccess: async () => {
      toggleDeleteAllFilesModal(false);
      toast.success('All knowledge files deleted');
    },
  });
  const downloadAllFiles = useDownload('/api/files/download', 'knowledges.zip');
  const [openDeleteAllSessionsModal, toggleDeleteAllSessionsModal] = useToggle();
  const [openDeleteAllFilesModal, toggleDeleteAllFilesModal] = useToggle();
  const [openImportHistoryModal, toggleImportHistoryModal] = useToggle();
  const [openNotebookExportModal, toggleNotebookExportModal] = useToggle();
  const [openNotebookImportModal, toggleNotebookImportModal] = useToggle();
  const [openNotebookCurationModal, toggleNotebookCurationModal] = useToggle();
  const [openImportHistoryJobsView, toggleImportHistoryJobsView] = useToggle();
  const [uploadProgress, setUploadProgress] = useState(0);

  const toggleHelp = () => updatePreferences({ showHelp: !settings.showHelp });

  const handleImportHistoryUpload = async (source: 'OpenAI' | 'Claude', file: File) => {
    // The server decides where the bytes go: a presigned S3 PUT when hosted, or a same-origin
    // proxy path on self-host, where MinIO is neither browser-reachable nor CSP-allowed.
    // uploadFileToUrl is what knows to send the app's Bearer to the latter and withhold it from
    // the former, so this must not PUT directly (see browserUploadCallSites.test.ts).

    try {
      const uploadUrl = await api.get(`/api/import-history/upload?source=${source}`).then(res => res.data.url);
      // The File streams straight through; reading it into an ArrayBuffer first would hold an
      // entire history export in browser memory.
      await uploadFileToUrl(uploadUrl, file, file.type, {
        onUploadProgress: progressEvent => {
          if (progressEvent.total) {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            setUploadProgress(percentCompleted);
          }
        },
      });
      toast.success('LLM history uploaded to servers successfully');
    } catch (err) {
      toast.error(`Failed to upload LLM history: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploadProgress(0);
    }
  };

  const handleImportUrlUpload = async (source: 'OpenAI' | 'Claude', url: string) => {
    // Download the file from the URL, then upload it using handleImportHistoryUpload()
    // Use axios instead of api here because of Authorization headers
    const blob = await axios.get(url, { responseType: 'blob' });
    const file = new File([blob.data], `${source.toLowerCase()}-history.zip`, {
      type: (blob.headers['Content-Type'] ?? 'application/octet-stream').toString(),
    });
    await handleImportHistoryUpload(source, file);
  };

  const handleNotebookImport = async (data: unknown, options: unknown) => {
    // Import is handled by the modal via API; placeholder for extra logic
    console.log('Notebook import completed:', data);
  };

  const handleShowImportHistory = () => {
    toggleImportHistoryModal(false);
    toggleNotebookImportModal(false);
    toggleImportHistoryJobsView(true);
  };

  return (
    <Stack spacing={3}>
      <SectionContainer>
        {/* Header Row with Title and Action Buttons */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Typography level="title-md">Application Settings</Typography>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button
              startDecorator={<HelpIcon />}
              variant="outlined"
              color="neutral"
              sx={{
                color: 'text.primary',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                '& .MuiButton-startDecorator': {
                  color: 'text.primary',
                  opacity: 0.5,
                },
              }}
              onClick={toggleHelp}
            >
              Help
            </Button>
            <LanguageSelector />
            <Button
              startDecorator={<CloudUpload />}
              variant="outlined"
              color="neutral"
              sx={{
                color: 'text.primary',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                '& .MuiButton-startDecorator': {
                  color: 'text.primary',
                  opacity: 0.5,
                },
              }}
              onClick={() => toggleImportHistoryModal()}
            >
              {t('importLLMHistory', { name: t('tools.title') })}
            </Button>
          </Box>
        </Box>

        <Grid container spacing={2}>
          {/* New Frame Sections */}
          <Grid xs={12} md={6}>
            <Box
              sx={theme => ({
                ...cardSurfaceSx(theme),
                display: 'flex',
                alignItems: 'center',
                // wrap the trailing controls below the title when the row is too
                // narrow, instead of squeezing them until their labels overlap.
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px',
                height: '100%',
              })}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
                  Notebooks
                </Typography>
              </Box>
              <Box
                sx={{
                  display: 'flex',
                  gap: 1.5,
                  alignItems: 'center',
                  flexShrink: 0,
                  flexWrap: 'wrap',
                  // when the group wraps to its own line, the parent's
                  // space-between collapses to flex-start for a single item - ml:auto
                  // keeps it right-aligned; maxWidth prevents overflow on very narrow widths.
                  justifyContent: 'flex-end',
                  ml: 'auto',
                  maxWidth: '100%',
                }}
              >
                <SettingsActionButton
                  color="primary"
                  variant="outlined"
                  data-testid="notebook-import-open-btn"
                  onClick={() => toggleNotebookImportModal()}
                  sx={{ fontSize: '13px' }}
                >
                  Import
                </SettingsActionButton>
                <SettingsActionButton
                  color="primary"
                  variant="outlined"
                  data-testid="notebook-export-open-btn"
                  onClick={() => toggleNotebookExportModal()}
                  sx={{ fontSize: '13px' }}
                >
                  Export All
                </SettingsActionButton>
                <SettingsActionButton
                  color="primary"
                  variant="solid"
                  onClick={() => toggleNotebookCurationModal()}
                  sx={{ fontSize: '13px' }}
                  data-testid="curate-btn"
                >
                  Curate
                </SettingsActionButton>
              </Box>
            </Box>
          </Grid>

          <Grid xs={12} md={6}>
            <Box
              sx={theme => ({
                ...cardSurfaceSx(theme),
                display: 'flex',
                alignItems: 'center',
                // wrap the trailing controls below the title when the row is too
                // narrow, instead of squeezing them until their labels overlap.
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px',
                height: '100%',
              })}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
                  Knowledge Files
                </Typography>
              </Box>
              <Box
                sx={{
                  display: 'flex',
                  gap: 1.5,
                  alignItems: 'center',
                  flexShrink: 0,
                  flexWrap: 'wrap',
                  // when the group wraps to its own line, the parent's
                  // space-between collapses to flex-start for a single item - ml:auto
                  // keeps it right-aligned; maxWidth prevents overflow on very narrow widths.
                  justifyContent: 'flex-end',
                  ml: 'auto',
                  maxWidth: '100%',
                }}
              >
                <SettingsActionButton
                  color="primary"
                  variant="outlined"
                  onClick={() => downloadAllFiles.mutate()}
                  sx={{ fontSize: '13px' }}
                >
                  Export All
                </SettingsActionButton>
              </Box>
            </Box>
          </Grid>
        </Grid>
      </SectionContainer>

      {/* Beta Features Section */}
      {!serverSettingsLoading && hasExperimentalFeatures && (
        <SectionContainer
          title={t('settings.experimental_features.beta_features.title')}
          subtitle={t('settings.experimental_features.beta_features.subtitle')}
        >
          <ExperimentalFeatureToggle />
        </SectionContainer>
      )}

      {/* Security Section */}
      <Box ref={securitySectionRef} data-testid="settings-security-section">
        <SectionContainer title="Security">
          <MfaCard />
          <ActiveSessionsSection />
          <ApprovedAppsSection />
        </SectionContainer>
      </Box>

      <VoicePreferenceSection />

      <DocxTemplateSection />

      {/* Display Settings Section */}
      <SectionContainer title="Display">
        <Grid container spacing={2}>
          <Grid xs={12} md={6}>
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
                  Splash Screen Cards
                </Typography>
                <Typography level="body-sm" sx={{ mt: 0.5 }}>
                  Show prompt suggestion cards on the splash screen
                </Typography>
              </Box>
              <Switch
                checked={settings.showSplashCards}
                onChange={e => updatePreferences({ showSplashCards: e.target.checked })}
              />
            </Box>
          </Grid>

          <Grid xs={12} md={6}>
            <Box
              sx={theme => ({
                ...cardSurfaceSx(theme),
                display: 'flex',
                alignItems: 'center',
                // wrap the trailing controls below the title when the row is too
                // narrow, instead of squeezing them until their labels overlap.
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px',
                height: '100%',
              })}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
                  Auto-collapse Long Content
                </Typography>
                <Typography level="body-sm" sx={{ mt: 0.5 }}>
                  Automatically collapse long code blocks and text in chat
                </Typography>
              </Box>
              <Switch
                checked={settings.autoCollapseContent}
                onChange={e => updatePreferences({ autoCollapseContent: e.target.checked })}
              />
            </Box>
          </Grid>

          {settings.autoCollapseContent && (
            <Grid xs={12} md={6}>
              <Box
                sx={theme => ({
                  ...cardSurfaceSx(theme),
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  height: '100%',
                })}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
                    Max Visible Lines
                  </Typography>
                  <Typography level="body-sm" sx={{ mt: 0.5 }}>
                    Number of lines to show before collapsing
                  </Typography>
                </Box>
                <Input
                  type="number"
                  defaultValue={settings.maxVisibleLines}
                  onBlur={e => updatePreferences({ maxVisibleLines: parseInt(e.target.value) || 25 })}
                  slotProps={{
                    input: {
                      min: 5,
                      max: 100,
                    },
                  }}
                  sx={{ width: 100 }}
                  endDecorator={<span>lines</span>}
                />
              </Box>
            </Grid>
          )}

          <Grid xs={12} md={6}>
            <Box
              sx={theme => ({
                ...cardSurfaceSx(theme),
                display: 'flex',
                alignItems: 'center',
                // wrap the trailing controls below the title when the row is too
                // narrow, instead of squeezing them until their labels overlap.
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px',
                height: '100%',
              })}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500 }}>
                  Scrollbar Width
                </Typography>
                <Typography level="body-sm" sx={{ mt: 0.5 }}>
                  Width of the scrollbar in the chat area
                </Typography>
              </Box>
              <Input
                type="number"
                defaultValue={settings.scrollbarWidth}
                onBlur={e => updatePreferences({ scrollbarWidth: parseInt(e.target.value) || 10 })}
                slotProps={{
                  input: {
                    min: 4,
                    max: 20,
                  },
                }}
                sx={{ width: 100 }}
                endDecorator={<span>px</span>}
              />
            </Box>
          </Grid>
        </Grid>
      </SectionContainer>

      <SectionContainer title="Danger zone">
        <Box
          data-testid="settings-danger-zone"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            p: 2,
            border: '1px solid',
            borderColor: 'danger.outlinedBorder',
            borderRadius: 'md',
          }}
        >
          <Typography level="body-sm">
            These can&apos;t be undone. To keep a copy, first use Export All on the Notebooks and Knowledge Files cards
            above.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button
              color="danger"
              variant="outlined"
              startDecorator={<DeleteOutline />}
              onClick={() => toggleDeleteAllSessionsModal()}
              data-testid="settings-delete-all-notebooks-btn"
            >
              Delete all notebooks
            </Button>
            <Button
              color="danger"
              variant="outlined"
              startDecorator={<DeleteOutline />}
              onClick={() => toggleDeleteAllFilesModal()}
              data-testid="settings-delete-all-files-btn"
            >
              Delete all knowledge files
            </Button>
          </Box>
        </Box>
      </SectionContainer>

      {openDeleteAllSessionsModal && (
        <DeleteAllNotebooksConfirm
          onCancel={toggleDeleteAllSessionsModal}
          onConfirm={() => deleteAllSessions.mutate()}
          pending={deleteAllSessions.isPending}
        />
      )}
      {openDeleteAllFilesModal && (
        <DeleteAllKnowledgeFilesConfirm
          onCancel={toggleDeleteAllFilesModal}
          onConfirm={() => deleteAllFiles.mutate()}
          pending={deleteAllFiles.isPending}
        />
      )}
      <UploadImportHistoryModal
        open={openImportHistoryModal}
        onClose={() => toggleImportHistoryModal(false)}
        onUpload={handleImportHistoryUpload}
        onUrlGiven={handleImportUrlUpload}
        uploadProgress={uploadProgress}
        onShowHistory={handleShowImportHistory}
      />
      <NotebookExportModal open={openNotebookExportModal} onClose={() => toggleNotebookExportModal(false)} />
      <NotebookImportModal
        open={openNotebookImportModal}
        onClose={() => toggleNotebookImportModal(false)}
        onImport={handleNotebookImport}
        onShowHistory={handleShowImportHistory}
      />
      <NotebookCurationModal open={openNotebookCurationModal} onClose={() => toggleNotebookCurationModal(false)} />
      {openImportHistoryJobsView && (
        <Modal open={openImportHistoryJobsView} onClose={() => toggleImportHistoryJobsView(false)}>
          <ModalDialog sx={{ width: '90vw', maxWidth: 1200, p: 0 }}>
            <ModalClose />
            <ImportHistoryJobsList onClose={() => toggleImportHistoryJobsView(false)} />
          </ModalDialog>
        </Modal>
      )}
    </Stack>
  );
};

export default GeneralSettingsTab;
