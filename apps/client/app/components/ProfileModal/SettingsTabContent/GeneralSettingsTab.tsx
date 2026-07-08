import UploadImportHistoryModal from '@/app/components/ProfileModal/UploadImportHistoryModal';
import NotebookExportModal from '@/app/components/ProfileModal/NotebookExportModal';
import NotebookImportModal from '@/app/components/ProfileModal/NotebookImportModal';
import NotebookCurationModal from '@/app/components/ProfileModal/NotebookCurationModal';
import ImportHistoryJobsList from '@/app/components/ProfileModal/ImportHistoryJobsList';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useDeleteAllFiles } from '@client/app/hooks/data/fabFiles';
import { useDeleteAllSessions } from '@client/app/hooks/data/sessions';
import { useDownload } from '@client/app/hooks/useDownload';
import useToggle from '@client/app/hooks/useToggle';
import { CloudUpload } from '@mui/icons-material';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import {
  Button,
  Grid,
  Stack,
  styled,
  Box,
  IconButton,
  Dropdown,
  Menu,
  MenuButton,
  MenuItem,
  Modal,
  ModalDialog,
  ModalClose,
  Alert,
  Switch,
  Input,
} from '@mui/joy';
import axios from 'axios';
import { toast } from 'sonner';

import { api } from '@client/app/contexts/ApiContext';
import HelpIcon from '@mui/icons-material/Help';
import { Typography } from '@mui/joy';
import { MoreVert as MoreVertIcon } from '@mui/icons-material';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import LanguageSelector from '@client/app/components/LanguageSelector';
import { useTranslation } from 'react-i18next';
import VoicePreferenceSection from './VoicePreferenceSection';
import DocxTemplateSection from './DocxTemplateSection';
import ExperimentalFeatureToggle from '../ExperimentalFeatureToggle';
import { useExperimentalFeatureSettings, useSettingsFromServer } from '@client/app/hooks/data/settings';
import { useMFAStatus, useSetupMFA, useVerifyMFASetup, useCancelMFASetup } from '@client/app/hooks/data/mfa';
import MFAModal from '@client/app/components/common/MFAModal';
import { useEffect, useRef, useState } from 'react';
import { useSearch } from '@tanstack/react-router';

const StyledButton = styled(Button)(({ theme }) => ({
  // Common style for action buttons for this screen
  gap: '.5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  whiteSpace: 'normal',
  flexDirection: 'row',
  height: '28px',
  minHeight: '28px',
  [theme.breakpoints.down('sm')]: {
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    textAlign: 'center',
    height: 'auto',
    minHeight: '28px',
    paddingTop: '6px',
    paddingBottom: '6px',
  },
}));

const GeneralSettingsTab = () => {
  const { settings, updatePreferences } = useUserSettings();
  const { isLoading: serverSettingsLoading } = useSettingsFromServer();
  const { data: experimentalSettingsWithDefaults } = useExperimentalFeatureSettings();

  const { data: mfaStatus } = useMFAStatus();
  const setupMFA = useSetupMFA();
  const verifyMFASetup = useVerifyMFASetup();
  const cancelMFASetup = useCancelMFASetup();

  // MFA modal state
  const [showMFAModal, setShowMFAModal] = useState(false);
  const [showBackupCodes, setShowBackupCodes] = useState<string[] | null>(null);

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
      toggleDeleteAllSessionsModal();
      toast.success('All sessions deleted');
    },
  });
  const deleteAllFiles = useDeleteAllFiles({
    onSuccess: async () => {
      toggleDeleteAllFilesModal();
      toast.success('All files deleted');
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
    // Upload file data to S3, using the API to gather the signed URL
    const content = await file.arrayBuffer();
    const uploadUrl = await api.get(`/api/import-history/upload?source=${source}`).then(res => res.data.url);
    console.debug(`Uploading ${file.name} (${file.size} bytes) to ${uploadUrl} (content type ${file.type})`);

    // Use axios instead of api here because of Authorization headers
    const response = await axios.put(uploadUrl, content, {
      headers: { 'Content-Type': file.type },
      onUploadProgress: progressEvent => {
        if (progressEvent.total) {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setUploadProgress(percentCompleted);
        }
      },
    });

    setUploadProgress(0);

    if (response.status === 200) {
      toast.success('LLM history uploaded to servers successfully');
    } else {
      toast.error(`Failed to upload LLM history: ${response.statusText}`);
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

  const handleEnableMFA = () => {
    setupMFA.mutate(undefined, {
      onSuccess: data => {
        setShowMFAModal(true);
        toast.success('MFA setup initiated');
      },
      onError: (error: { response?: { data?: { error?: string } }; message?: string }) => {
        const errorMessage = error.response?.data?.error || error.message || 'Failed to setup MFA';
        toast.error(errorMessage);
      },
    });
  };

  const handleMFAVerification = (token: string) => {
    verifyMFASetup.mutate(
      { token },
      {
        onSuccess: (data: { backupCodes?: string[] }) => {
          setShowMFAModal(false);
          if (data.backupCodes) {
            setShowBackupCodes(data.backupCodes);
          }
          toast.success('MFA enabled successfully');
        },
        onError: (error: {
          response?: { data?: { error?: string; attemptsRemaining?: number } };
          message?: string;
        }) => {
          const errorData = error.response?.data;
          const baseError = errorData?.error || error.message || 'MFA verification failed';
          const attemptsInfo = errorData?.attemptsRemaining
            ? ` (${errorData.attemptsRemaining} attempts remaining)`
            : '';
          toast.error(baseError + attemptsInfo);
        },
      }
    );
  };

  const handleCancelSetup = () => {
    cancelMFASetup.mutate(undefined, {
      onSuccess: () => {
        setShowMFAModal(false);
        toast.info('MFA setup cancelled');
      },
    });
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
                <StyledButton
                  color="primary"
                  variant="outlined"
                  onClick={() => toggleNotebookImportModal()}
                  sx={{ fontSize: '13px' }}
                >
                  Import
                </StyledButton>
                <StyledButton
                  color="primary"
                  variant="outlined"
                  onClick={() => toggleNotebookExportModal()}
                  sx={{ fontSize: '13px' }}
                >
                  Export All
                </StyledButton>
                <StyledButton
                  color="primary"
                  variant="solid"
                  onClick={() => toggleNotebookCurationModal()}
                  sx={{ fontSize: '13px' }}
                  data-testid="curate-btn"
                >
                  Curate
                </StyledButton>
                <Dropdown>
                  <MenuButton
                    size={'md'}
                    sx={{
                      padding: '8px',
                      border: '1px solid',
                      borderColor: 'neutral.outlinedBorder',
                      color: 'neutral.outlinedColor',
                      width: '28px !important',
                      height: '28px !important',
                      minWidth: '28px !important',
                      minHeight: '28px !important',
                      '&:hover': {
                        backgroundColor: 'neutral.outlinedHoverBg',
                        borderColor: 'neutral.outlinedHoverBorder',
                      },
                    }}
                    slots={{ root: IconButton }}
                    slotProps={{ root: { variant: 'outlined', color: 'neutral' } }}
                  >
                    <MoreVertIcon sx={{ fontSize: '18px' }} width={'16px'} height={'16px'} />
                  </MenuButton>
                  <Menu
                    className="menuSurface"
                    sx={{
                      zIndex: 10001,
                      borderRadius: '10px',
                    }}
                    variant={'outlined'}
                    placement={'bottom'}
                    direction="ltr"
                  >
                    <MenuItem onClick={() => toggleDeleteAllSessionsModal()} color="danger">
                      <DeleteOutline sx={{ fontSize: '18px' }} width={'16px'} height={'16px'} />
                      {t('deleteAllSomething', { name: t('llm.session_plural') })}
                    </MenuItem>
                  </Menu>
                </Dropdown>
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
                <StyledButton
                  color="primary"
                  variant="outlined"
                  onClick={() => downloadAllFiles.mutate()}
                  sx={{ fontSize: '13px' }}
                >
                  Export All
                </StyledButton>
                <Dropdown>
                  <MenuButton
                    size={'md'}
                    sx={{
                      padding: '8px',
                      border: '1px solid',
                      borderColor: 'neutral.outlinedBorder',
                      color: 'neutral.outlinedColor',
                      width: '28px !important',
                      height: '28px !important',
                      minWidth: '28px !important',
                      minHeight: '28px !important',
                      '&:hover': {
                        backgroundColor: 'neutral.outlinedHoverBg',
                        borderColor: 'neutral.outlinedHoverBorder',
                      },
                    }}
                    slots={{ root: IconButton }}
                    slotProps={{ root: { variant: 'outlined', color: 'neutral' } }}
                  >
                    <MoreVertIcon sx={{ fontSize: '18px' }} width={'16px'} height={'16px'} />
                  </MenuButton>
                  <Menu
                    className="menuSurface"
                    sx={{
                      zIndex: 10001,
                      borderRadius: '10px',
                    }}
                    variant={'outlined'}
                    placement={'bottom'}
                    direction="ltr"
                  >
                    <MenuItem onClick={() => toggleDeleteAllFilesModal()} color="danger">
                      <DeleteOutline sx={{ fontSize: '18px' }} width={'16px'} height={'16px'} />
                      {t('deleteAllSomething', { name: t('file') })}
                    </MenuItem>
                  </Menu>
                </Dropdown>
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
      <Box ref={securitySectionRef}>
        <SectionContainer title="Security">
          <Grid container spacing={2}>
            {/* Multi-Factor Authentication Section */}
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
                    Multi-Factor Authentication
                  </Typography>
                  <Typography level="body-sm" sx={{ mt: 0.5 }}>
                    Status:{' '}
                    {mfaStatus?.enabled ? (
                      <span style={{ color: 'green', fontWeight: 'bold' }}>Enabled</span>
                    ) : (
                      <span style={{ color: 'orange', fontWeight: 'bold' }}>Disabled</span>
                    )}
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
                  {!mfaStatus?.enabled && (
                    <StyledButton
                      color="primary"
                      variant="solid"
                      onClick={handleEnableMFA}
                      loading={setupMFA.isPending}
                      sx={{ fontSize: '13px' }}
                    >
                      Enable
                    </StyledButton>
                  )}
                </Box>
              </Box>
            </Grid>
          </Grid>
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

      {openDeleteAllSessionsModal && (
        <ConfirmActionModal
          title="Delete All Sessions"
          description="Are you sure you want to delete all sessions? This action cannot be undone."
          onGoBackward={toggleDeleteAllSessionsModal}
          onGoForward={() => deleteAllSessions.mutate()}
          disabledConfirm={deleteAllSessions.isPending}
        />
      )}
      {openDeleteAllFilesModal && (
        <ConfirmActionModal
          title="Delete All Files"
          description="Are you sure you want to delete all files? This action cannot be undone."
          onGoBackward={toggleDeleteAllFilesModal}
          onGoForward={() => deleteAllFiles.mutate()}
          disabledConfirm={deleteAllFiles.isPending}
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
      {/* MFA Setup Modal for Security Section */}
      {showMFAModal && (
        <MFAModal
          key={`mfa-setup-${setupMFA.data?.secret || 'loading'}`}
          open={showMFAModal}
          onClose={() => setShowMFAModal(false)}
          onCancel={handleCancelSetup}
          title="Set Up Multi-Factor Authentication"
          description="Scan the QR code with your authenticator app, then enter the verification code."
          qrCodeUrl={setupMFA.data?.qrCodeUrl}
          manualEntryKey={setupMFA.data?.manualEntryKey}
          backupCodes={setupMFA.data?.backupCodes}
          onVerify={handleMFAVerification}
          loading={setupMFA.isPending || verifyMFASetup.isPending}
          showVerify={!setupMFA.isPending && !setupMFA.isError && !!setupMFA.data}
          isEnforced={false}
        />
      )}

      {/* Backup Codes Modal for Security Section */}
      <Modal open={!!showBackupCodes} onClose={() => setShowBackupCodes(null)}>
        <ModalDialog>
          <ModalClose />
          <Typography level="h4" sx={{ mb: 2 }}>
            Your Backup Codes
          </Typography>
          <Alert color="warning" sx={{ mb: 2 }}>
            Save these backup codes in a secure location. Each code can only be used once.
          </Alert>
          {showBackupCodes && (
            <Box
              sx={{
                fontFamily: 'monospace',
                fontSize: '14px',
                backgroundColor: 'background.level1',
                p: 2,
                borderRadius: 'md',
                mb: 2,
              }}
            >
              {showBackupCodes.map((code, index) => (
                <div key={index}>{code}</div>
              ))}
            </Box>
          )}
          <Button onClick={() => setShowBackupCodes(null)}>I&apos;ve Saved These Codes</Button>
        </ModalDialog>
      </Modal>
    </Stack>
  );
};

export default GeneralSettingsTab;
