import {
  Modal,
  ModalDialog,
  Typography,
  Divider,
  Box,
  Stack,
  Button,
  Chip,
  Sheet,
  Input,
  IconButton,
  Grid,
} from '@mui/joy';
import { FC, useState } from 'react';
import MarkdownViewer from '../Knowledge/MarkdownViewer';
import CloseIcon from '@mui/icons-material/Close';
import FavoriteIcon from '@mui/icons-material/Favorite';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import { FavoriteDocumentType, ISessionDocument } from '@bike4mind/common';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { updateSessionToServer } from '@client/app/utils/sessionsAPICalls';
import { useToggleFavoriteSession } from '@client/app/hooks/data/sessions';
import { useCheckFavorite } from '@client/app/hooks/data/favorites';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';

interface SessionMetadataModalProps {
  session: ISessionDocument;
  onClose: () => void;
}

const SessionMetadataModal: FC<SessionMetadataModalProps> = ({ session, onClose }) => {
  const { setSessionsMetaDataVersion } = useSessions();
  const [sessionTags, setSessionTags] = useState(session.tags || []);
  const [newTag, setNewTag] = useState('');
  const toggleFavoriteSession = useToggleFavoriteSession(session.id);
  const { data: isFavorite } = useCheckFavorite(session.id, FavoriteDocumentType.Sessions);

  const handleFavoriteClick = async () => {
    try {
      await toggleFavoriteSession.mutateAsync();
      setSessionsMetaDataVersion(prevVersion => prevVersion + 1);
    } catch (error) {
      console.error('Error updating session favorite:', error);
    }
  };

  const handleAddTag = async (tagToAdd?: string) => {
    const tagName = tagToAdd ? tagToAdd : newTag.trim();
    if (tagName === '') return;

    if (sessionTags.some(tag => tag.name === tagName)) {
      return;
    }

    const updatedTags = [...sessionTags, { name: tagName, strength: 100 }];

    try {
      const updatedSession = {
        ...session,
        tags: updatedTags,
      };
      await updateSessionToServer(updatedSession);
      setSessionTags(updatedTags);
      setNewTag('');
      setSessionsMetaDataVersion(prevVersion => prevVersion + 1);
    } catch (error) {
      console.error('Error adding tag:', error);
    }
  };

  const handleRemoveTag = async (tagName: string) => {
    const updatedTags = sessionTags.filter(tag => tag.name !== tagName);

    try {
      const updatedSession = {
        ...session,
        tags: updatedTags,
      };
      await updateSessionToServer(updatedSession);
      setSessionTags(updatedTags);
      setSessionsMetaDataVersion(prevVersion => prevVersion + 1);
    } catch (error) {
      console.error('Error removing tag:', error);
    }
  };

  return (
    <Modal
      className="session-metadata-modal"
      open={true}
      onClose={onClose}
      sx={{ maxWidth: '100%', maxHeight: '100%' }}
    >
      <ModalDialog
        className="session-metadata-dialog"
        aria-labelledby="session-metadata-modal-title"
        aria-describedby="session-metadata-modal-description"
        size="lg"
        layout="center"
        sx={{
          height: '100%',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Grid container spacing={2} alignItems="flex-start">
          <Grid component="div" xs={8}>
            <Typography className="session-metadata-title" id="session-metadata-modal-title" level="h2" sx={{ mb: 1 }}>
              {formatSessionTitle(session.name)}
            </Typography>
            <Button
              className="session-metadata-favorite-button"
              variant="outlined"
              color={isFavorite ? 'success' : 'neutral'}
              onClick={handleFavoriteClick}
              startDecorator={isFavorite ? <FavoriteIcon /> : <FavoriteBorderIcon />}
            >
              {isFavorite ? 'Unfavorite' : 'Favorite'}
            </Button>
          </Grid>

          <Grid component="div" xs={3}>
            <Typography level="body-sm" sx={{ mb: 0.5 }}>
              <strong>First Created:</strong> {new Date(session.firstCreated).toLocaleString()}
            </Typography>
            <Typography level="body-sm">
              <strong>Last Updated:</strong> {new Date(session.lastUpdated).toLocaleString()}
            </Typography>
          </Grid>

          <Grid component="div" xs={1} sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              className="session-metadata-close-btn"
              data-testid="session-metadata-close-btn"
              size="sm"
              variant="plain"
              onClick={onClose}
            >
              <CloseIcon />
            </Button>
          </Grid>
        </Grid>

        <Divider />

        <Grid
          container
          disableEqualOverflow
          sx={{
            flexGrow: 1,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Grid
            component="div"
            sx={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              mt: 0,
            }}
          >
            <Typography className="session-metadata-section-title" level="title-md" sx={{ mb: 0.5 }}>
              Session Tags
            </Typography>
            <Box
              sx={{
                maxHeight: '120px',
                overflowY: 'auto',
                mb: 0.5,
              }}
            >
              {sessionTags && sessionTags.length > 0 && (
                <Stack direction="row" flexWrap="wrap" gap={1}>
                  {sessionTags.map((tag, index) => (
                    <Chip
                      className="session-metadata-tag"
                      data-testid="session-metadata-tag"
                      key={index}
                      variant="outlined"
                      color="primary"
                      size="sm"
                      sx={{ borderRadius: 'sm' }}
                    >
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <Typography level="body-sm">{tag.name}</Typography>
                        <Typography color="primary" level="body-xs">
                          {tag.strength}
                        </Typography>
                        <IconButton
                          className="session-metadata-tag-remove-button"
                          size="sm"
                          variant="plain"
                          onClick={() => handleRemoveTag(tag.name)}
                        >
                          <CloseIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    </Chip>
                  ))}
                </Stack>
              )}
            </Box>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Input
                className="session-metadata-tag-input"
                data-testid="session-metadata-tag-input"
                placeholder="Add a tag"
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyPress={e => {
                  if (e.key === 'Enter') {
                    handleAddTag();
                  }
                }}
                sx={{ flex: 1 }}
              />
              <Button
                className="session-metadata-tag-add-btn"
                data-testid="session-metadata-tag-add-btn"
                variant="outlined"
                onClick={() => handleAddTag()}
              >
                Add Tag
              </Button>
            </Stack>
          </Grid>

          <Divider sx={{ mt: 1.5, mb: 1 }} />

          <Grid
            component="div"
            sx={{
              width: '100%',
              flex: 1,
              paddingBottom: 0.5,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            <Typography level="title-md" sx={{ mb: 0.5 }}>
              Session Summary
            </Typography>
            <Typography level="body-sm" sx={{ color: 'text.secondary', mb: 0.5 }}>
              Summarized at: {session.summaryAt ? new Date(session.summaryAt).toLocaleString() : 'Not summarized yet'}
            </Typography>
            <Sheet
              className="session-metadata-summary"
              variant="outlined"
              sx={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
                borderRadius: 'md',
              }}
            >
              <MarkdownViewer content={session.summary || '<no summary>'} />
            </Sheet>
          </Grid>
        </Grid>
      </ModalDialog>
    </Modal>
  );
};

export default SessionMetadataModal;
