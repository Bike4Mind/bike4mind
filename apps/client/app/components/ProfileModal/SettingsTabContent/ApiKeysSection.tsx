import { ApiKeyType, IApiKeyDocument } from '@bike4mind/common';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import AddApiKeyModal from '@client/app/components/ProfileModal/AddApiKeyModal';
import AddVoiceModal from '@client/app/components/ProfileModal/AddVoiceModal';
import { useDeleteApiKey, useGetAllApiKeys, useSetActiveApiKey } from '@client/app/hooks/data/apiKeys';
import { useDeleteVoice, useGetAllVoice, useSetVoice } from '@client/app/hooks/data/voice';
import { MoreVert as MoreVertIcon } from '@mui/icons-material';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import {
  Box,
  Button,
  IconButton,
  LinearProgress,
  Table,
  Tooltip,
  Typography,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  CircularProgress,
  Dropdown,
  Menu,
  MenuButton,
  MenuItem,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { styled } from '@mui/system';
import SectionContainer from '../SectionContainer';
import { cardSurfaceSx, tableHeaderSx } from '../settingsStyles';
import { green } from '@client/app/utils/themes/colors';

const StyledTab = styled(Tab)(({ theme }) => ({
  borderBottomLeftRadius: '0',
  borderBottomRightRadius: '0',
  '&:hover:not([aria-selected="true"])': {
    backgroundColor: `${theme.palette.notebooklist.hoverBg} !important`,
    '& .MuiTypography-root': {
      opacity: 1,
    },
  },
  '& .MuiTypography-root': {
    opacity: 0.7,
  },
  '&[aria-selected="true"] .MuiTypography-root': {
    opacity: 1,
  },
}));

const SpeechTabContent = () => {
  const [targetDeleteVoiceId, setTargetDeleteVoiceId] = useState<string | null>(null);
  const { mutate: setActiveVoice } = useSetVoice();
  const { mutate: deleteVoice } = useDeleteVoice();
  const voiceQuery = useGetAllVoice();
  const { t } = useTranslation('common');

  return (
    <Box
      sx={theme => ({
        ...cardSurfaceSx(theme),
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        p: '1.25rem', // override the helper's 16px - this outer wrapper uses 20px padding
      })}
    >
      {/* Horizontal scroll keeps Date Added inside the card on narrow viewports. */}
      <Box sx={{ overflowX: 'auto' }}>
        <Table
          sx={{
            minWidth: 560,
            tableLayout: 'auto',
            '& thead th': { ...tableHeaderSx, whiteSpace: 'nowrap' },
            '& td': { fontSize: '14px', color: 'text.primary', verticalAlign: 'middle' },
          }}
        >
          <thead>
            <tr>
              <th>Key</th>
              <th>Description</th>
              <th>Date Added</th>
              <th aria-label="Actions" style={{ width: '140px' }} />
            </tr>
          </thead>
          <tbody>
            {voiceQuery.data?.map(key => (
              <tr key={key.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{key.voiceId}</td>
                <td>
                  <Tooltip title={key.description} placement="top" arrow>
                    <Box
                      sx={{
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        lineHeight: 1.4,
                        maxHeight: '2.8em',
                        cursor: 'pointer',
                      }}
                    >
                      {key.description}
                    </Box>
                  </Tooltip>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {key.createdAt ? new Intl.DateTimeFormat().format(new Date(key.createdAt)) : 'N/A'}
                </td>
                <td>
                  <Box sx={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', alignItems: 'center' }}>
                    {!key.isActive ? (
                      <Button
                        variant="solid"
                        onClick={() => setActiveVoice(key.id)}
                        sx={{
                          height: '28px',
                          minHeight: '28px',
                          padding: '4px 12px',
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                          backgroundColor: green[800],
                          color: 'white',
                          '&:hover': {
                            backgroundColor: green[875],
                          },
                        }}
                      >
                        Activate
                      </Button>
                    ) : (
                      <Box sx={{ color: green[800], fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        Current Voice
                      </Box>
                    )}

                    <Dropdown>
                      <MenuButton
                        size="sm"
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
                        <MenuItem onClick={() => setTargetDeleteVoiceId(key.id)} color="danger">
                          <DeleteOutline sx={{ fontSize: '20px' }} />
                          Delete a Key
                        </MenuItem>
                      </Menu>
                    </Dropdown>
                  </Box>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Box>

      {voiceQuery.isLoading && <CircularProgress className="profile-voice-tab-loading" sx={{ margin: 'auto' }} />}
      <AddVoiceModal />

      {targetDeleteVoiceId && (
        <ConfirmActionModal
          itemId={undefined}
          title={t('deleteVoice')}
          description="Are you sure you want to delete this voice? This action cannot be undone."
          onGoForward={() => {
            deleteVoice(targetDeleteVoiceId);
            setTargetDeleteVoiceId(null);
          }}
          onGoBackward={() => setTargetDeleteVoiceId(null)}
          forwardButtonText="Delete"
          backwardButtonText="Cancel"
        />
      )}
    </Box>
  );
};

const ApiKeysSection = () => {
  const [targetDeleteId, setTargetDeleteId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const { mutate: setOpenAiActive } = useSetActiveApiKey();
  const { mutate: setElabsActive } = useSetActiveApiKey(ApiKeyType.elevenlabs);
  const query = useGetAllApiKeys();
  const deleteApiKey = useDeleteApiKey({
    onSuccess: () => {
      setTargetDeleteId(null);
      toast.success('API Key Deleted');
    },
  });

  const initialKeys: { [key in ApiKeyType]?: { data: IApiKeyDocument[] } } = {
    [ApiKeyType.openai]: { data: [] },
    [ApiKeyType.elevenlabs]: { data: [] },
  };

  const groupedApiKeys = (query.data ?? []).reduce<{ [key in ApiKeyType]?: { data: IApiKeyDocument[] } }>(
    (acc, curr) => {
      const type = curr.type ?? ApiKeyType.openai;

      acc[type]?.data.push(curr);
      return acc;
    },
    initialKeys
  );

  return (
    <>
      <SectionContainer title="API Keys">
        {query.isFetching && <LinearProgress />}

        <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value as number)}>
          <TabList sx={{ gap: '2px' }}>
            <StyledTab value={0}>
              <Typography sx={{ color: 'text.primary' }}>API Keys</Typography>
            </StyledTab>
            <StyledTab value={1}>
              <Typography sx={{ color: 'text.primary' }}>Speech</Typography>
            </StyledTab>
          </TabList>

          <TabPanel value={0} sx={{ pt: '20px' }}>
            <Box sx={{ mb: '20px' }}>
              <ProviderContainer
                title="OpenAI"
                type={ApiKeyType.openai}
                items={groupedApiKeys.openAi?.data ?? []}
                onActivate={id => setOpenAiActive(id)}
                onDelete={id => setTargetDeleteId(id)}
              />
            </Box>

            <ProviderContainer
              title="ElevenLabs"
              type={ApiKeyType.elevenlabs}
              items={groupedApiKeys.elevenLabs?.data ?? []}
              onActivate={id => setElabsActive(id)}
              onDelete={id => setTargetDeleteId(id)}
            />
          </TabPanel>

          <TabPanel value={1} sx={{ pt: '20px' }}>
            <SpeechTabContent />
          </TabPanel>
        </Tabs>
      </SectionContainer>

      {targetDeleteId && (
        <ConfirmActionModal
          itemId={undefined}
          title="Delete API Key"
          description="Are you sure you want to delete this API key? This action cannot be undone."
          loading={deleteApiKey.isPending}
          onGoForward={() => {
            deleteApiKey.mutate(targetDeleteId);
          }}
          onGoBackward={() => setTargetDeleteId(null)}
          forwardButtonText="Delete"
          backwardButtonText="Cancel"
        />
      )}
    </>
  );
};

const ProviderContainer = ({
  title,
  type,
  items,
  onActivate,
  onDelete,
}: {
  title: string;
  type: ApiKeyType;
  items: IApiKeyDocument[];
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
}) => {
  return (
    <Box
      sx={theme => ({
        ...cardSurfaceSx(theme),
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        p: '1.25rem', // override the helper's 16px - this outer wrapper uses 20px padding
      })}
    >
      <Typography level="body-md" sx={{ fontSize: '18px', color: 'text.primary' }}>
        {title}
      </Typography>

      {/* Horizontal scroll keeps Date Added / Expires At inside the card on narrow viewports. */}
      <Box sx={{ overflowX: 'auto' }}>
        <Table
          sx={{
            minWidth: 680,
            tableLayout: 'auto',
            '& thead th': { ...tableHeaderSx, whiteSpace: 'nowrap' },
            '& td': { fontSize: '14px', color: 'text.primary', verticalAlign: 'middle' },
          }}
        >
          <thead>
            <tr>
              <th>Key</th>
              <th>Description</th>
              <th>Date Added</th>
              <th>Expires At</th>
              <th aria-label="Actions" style={{ width: '140px' }} />
            </tr>
          </thead>
          <tbody>
            {items.map(key => {
              const isExpired = key.expiresAt ? new Date(key.expiresAt) < new Date() : false;
              return (
                <tr key={key.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {key.apiKey.length <= 20
                      ? key.apiKey
                      : key.apiKey.substring(0, 8) + '...' + key.apiKey.substring(key.apiKey.length - 4)}
                  </td>
                  <td>
                    <Tooltip title={key.description} placement="top" arrow>
                      <Box
                        sx={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          lineHeight: 1.4,
                          maxHeight: '2.8em', // 2 lines * 1.4 line height
                          cursor: 'pointer',
                        }}
                      >
                        {key.description}
                      </Box>
                    </Tooltip>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {key.createdAt ? new Intl.DateTimeFormat().format(new Date(key.createdAt)) : 'N/A'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {key.expiresAt ? (
                      // Non-expired renders as plain text like the "Date Added" cell so it
                      // inherits the table's td -> text.primary. A bare <Typography> would
                      // apply body-sm's own color (text.tertiary) and read grayer than its
                      // neighbor, so only the expired state uses <Typography color="danger">.
                      isExpired ? (
                        <Typography level="body-sm" color="danger">
                          {new Intl.DateTimeFormat().format(new Date(key.expiresAt))} - Expired
                        </Typography>
                      ) : (
                        new Intl.DateTimeFormat().format(new Date(key.expiresAt))
                      )
                    ) : (
                      'N/A'
                    )}
                  </td>
                  <td>
                    <Box sx={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', alignItems: 'center' }}>
                      {!key.isActive ? (
                        <Button
                          variant="solid"
                          onClick={() => onActivate(key.id)}
                          sx={{
                            height: '28px',
                            minHeight: '28px',
                            padding: '4px 12px',
                            fontWeight: 500,
                            whiteSpace: 'nowrap',
                            backgroundColor: green[800],
                            color: 'white',
                            '&:hover': {
                              backgroundColor: green[875],
                            },
                          }}
                        >
                          Activate
                        </Button>
                      ) : (
                        <Box sx={{ color: green[800], fontSize: '14px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          Active
                        </Box>
                      )}

                      <Dropdown>
                        <MenuButton
                          size="sm"
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
                          <MenuItem onClick={() => onDelete(key.id)} color="danger">
                            <DeleteOutline sx={{ fontSize: '20px' }} />
                            Delete a Key
                          </MenuItem>
                        </Menu>
                      </Dropdown>
                    </Box>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Box>

      <Box>
        <AddApiKeyModal type={type as ApiKeyType}>
          {({ toggle }) => (
            <Tooltip title={`Add New ${title} Key`}>
              <Button
                variant="outlined"
                color="neutral"
                sx={{
                  gap: '.5rem',
                  '&:hover': {
                    backgroundColor: 'notebooklist.hoverBg',
                  },
                }}
                onClick={toggle}
              >
                <AddIcon sx={{ fontSize: 16 }} />
                <span>Add New Key</span>
              </Button>
            </Tooltip>
          )}
        </AddApiKeyModal>
      </Box>
    </Box>
  );
};

export default ApiKeysSection;
