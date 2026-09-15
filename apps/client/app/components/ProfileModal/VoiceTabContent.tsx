import Delete from '@mui/icons-material/Delete';
import { Box, Button, Card, CircularProgress, IconButton, Stack, Tooltip, Table } from '@mui/joy';
import { useDeleteVoice, useGetAllVoice, useSetVoice } from '@client/app/hooks/data/voice';
import { useState } from 'react';
import AddVoiceModal from './AddVoiceModal';
import ConfirmActionModal from '../ConfirmActionModal';
import { useTranslation } from 'react-i18next';

const VoiceTabContent = () => {
  const [targetDeleteId, setTargetDeleteId] = useState<string | null>(null);
  const { mutate: setActive } = useSetVoice();
  const { mutate: deleteVoice } = useDeleteVoice();
  const query = useGetAllVoice();
  const { t } = useTranslation('common');

  return (
    <Stack className="profile-voice-tab-root" spacing={2}>
      <Card className="profile-voice-tab-card" sx={{ overflow: 'auto' }}>
        <Table
          className="profile-voice-tab-table"
          sx={{ '& tr > *:not(:first-of-type)': { textAlign: 'right' }, minWidth: '1000px' }}
        >
          <thead>
            <tr>
              <th style={{ width: '40%' }}>Key</th>
              <th>Description</th>
              <th>Date Added</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.map(key => (
              <tr key={key.id}>
                <td>{key.voiceId}</td>
                <td>{key.description}</td>
                <td>{key.createdAt ? new Intl.DateTimeFormat().format(new Date(key.createdAt)) : 'N/A'}</td>
                <td>
                  <Box
                    sx={theme => ({
                      display: 'flex',
                      gap: theme.spacing(1),
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                    })}
                  >
                    {!key.isActive ? (
                      <Tooltip title={t('activateVoice')} arrow>
                        <Button
                          className="profile-voice-tab-activate-btn"
                          variant="solid"
                          color="success"
                          onClick={() => setActive(key.id)}
                        >
                          Activate
                        </Button>
                      </Tooltip>
                    ) : (
                      <Tooltip title={t('liveVoice')} arrow>
                        <Box className="profile-voice-tab-active-indicator" sx={{ color: 'green' }}>
                          {' '}
                          Current Voice
                        </Box>
                      </Tooltip>
                    )}

                    <Tooltip title={t('deleteVoice')} arrow>
                      <IconButton
                        className="profile-voice-tab-delete-btn"
                        color="danger"
                        onClick={() => setTargetDeleteId(key.id)}
                      >
                        <Delete />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>

        {query.isLoading && <CircularProgress className="profile-voice-tab-loading" sx={{ margin: 'auto' }} />}

        {targetDeleteId && (
          <ConfirmActionModal
            itemId={undefined}
            title={t('deleteVoice')}
            description="Are you sure you want to delete this voice? This action cannot be undone."
            onGoForward={() => {
              deleteVoice(targetDeleteId);
              setTargetDeleteId(null);
            }}
            onGoBackward={() => setTargetDeleteId(null)}
            forwardButtonText="Delete"
            backwardButtonText="Cancel"
          />
        )}
      </Card>
      <AddVoiceModal />
    </Stack>
  );
};
export default VoiceTabContent;
