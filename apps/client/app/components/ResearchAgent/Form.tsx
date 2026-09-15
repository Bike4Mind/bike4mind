import { FC, useEffect } from 'react';
import {
  Modal,
  ModalDialog,
  ModalClose,
  Box,
  Stack,
  Typography,
  FormControl,
  FormLabel,
  Input,
  Button,
  Textarea,
  Card,
  CardContent,
  Divider,
  useTheme,
} from '@mui/joy';
import { IResearchAgent } from '@bike4mind/common';
import { useForm } from 'react-hook-form';
import { SmartToy, Description, Badge, Save, Cancel, Psychology } from '@mui/icons-material';
import {
  blue,
  brand,
  purple,
  gray,
  whiteAlpha,
  blackAlpha,
  blueAlpha,
  brandAlpha,
  grayAlpha,
} from '../../utils/themes/colors';

interface ResearchAgentFormData {
  name: string;
  description: string;
}

interface ResearchAgentFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ResearchAgentFormData) => void;
  agent?: IResearchAgent;
  isSubmitting?: boolean;
}

const ResearchAgentForm: FC<ResearchAgentFormProps> = ({ open, onClose, onSubmit, agent, isSubmitting = false }) => {
  const isEditMode = !!agent;
  const theme = useTheme();
  const mode = theme.palette.mode;
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ResearchAgentFormData>({
    defaultValues: {
      name: '',
      description: '',
    },
  });

  useEffect(() => {
    if (open) {
      reset(
        agent
          ? {
              name: agent.name,
              description: agent.description,
            }
          : {
              name: '',
              description: '',
            }
      );
    }
  }, [open, agent, reset]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        backdropFilter: 'blur(4px)',
        padding: 2,
      }}
    >
      <ModalDialog
        sx={{
          width: '90vw',
          maxWidth: '550px',
          maxHeight: '75vh',
          overflowY: 'auto',
          overflowX: 'hidden',
          margin: 'auto',
          background:
            mode === 'dark'
              ? `linear-gradient(135deg, ${gray[850]} 0%, ${gray[900]} 100%)`
              : `linear-gradient(135deg, ${whiteAlpha[0][95]} 0%, ${grayAlpha[15][95]} 100%)`,
          boxShadow: `0 25px 50px -12px ${blackAlpha[0][25]}`,
          borderRadius: '16px',
          border: `1px solid ${mode === 'dark' ? grayAlpha[700][50] : whiteAlpha[0][20]}`,
          position: 'relative',
          transform: 'none',
          top: 'auto',
          left: 'auto',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '4px',
            background: `linear-gradient(90deg, ${blue[400]} 0%, ${brand[500]} 50%, ${purple[500]} 100%)`,
            zIndex: 1,
          },
        }}
      >
        <ModalClose
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 10,
            borderRadius: '50%',
            transition: 'all 0.2s ease',
            '&:hover': {
              bgcolor: 'danger.softHoverBg',
              transform: 'scale(1.1)',
            },
          }}
        />

        <Box sx={{ p: 3 }}>
          {/* Header */}
          <Box sx={{ textAlign: 'center', mb: 3, mt: 1 }}>
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'center',
                mb: 1.5,
                '& svg': {
                  fontSize: 40,
                  background: `linear-gradient(135deg, ${blue[400]} 0%, ${brand[500]} 50%, ${purple[500]} 100%)`,
                  backgroundClip: 'text',
                  WebkitBackgroundClip: 'text',
                  color: 'transparent',
                  filter: `drop-shadow(0 2px 4px ${blackAlpha[0][10]})`,
                },
              }}
            >
              {isEditMode ? <Psychology /> : <SmartToy />}
            </Box>
            <Typography
              level="h4"
              sx={{
                background:
                  mode === 'dark'
                    ? `linear-gradient(135deg, ${gray[50]} 0%, ${gray[200]} 100%)`
                    : `linear-gradient(135deg, ${gray[780]} 0%, ${gray[750]} 100%)`,
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                color: 'transparent',
                fontWeight: 700,
                letterSpacing: '-0.025em',
                mb: 0.5,
              }}
            >
              {isEditMode ? 'Perfect Your AI Research Agent' : 'Create a Research Agent'}
            </Typography>
            <Typography level="body-sm" color="neutral" sx={{ maxWidth: 350, mx: 'auto' }}>
              {isEditMode
                ? 'Fine-tune your AI agent to deliver even better research results'
                : 'Design an AI-powered research agent that will work tirelessly to gather insights for you'}
            </Typography>
          </Box>

          <form onSubmit={handleSubmit(onSubmit)}>
            <Stack spacing={2.5}>
              <Card
                variant="outlined"
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: mode === 'dark' ? grayAlpha[800][50] : 'background.surface',
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    borderColor: 'primary.300',
                    boxShadow: mode === 'dark' ? `0 2px 8px ${blackAlpha[0][30]}` : `0 2px 8px ${blackAlpha[0][10]}`,
                  },
                }}
              >
                <CardContent>
                  <FormControl error={!!errors.name}>
                    <FormLabel sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 600 }}>
                      <Badge sx={{ fontSize: 18, color: 'primary.500' }} />
                      Agent Name
                    </FormLabel>
                    <Input
                      {...register('name', {
                        required: 'Name is required',
                        minLength: {
                          value: 3,
                          message: 'Name must be at least 3 characters',
                        },
                      })}
                      placeholder="Give your AI agent a memorable name..."
                      size="lg"
                      sx={{
                        '--Input-focusedThickness': '2px',
                        '--Input-focusedHighlight': blueAlpha[650][25],
                        transition: 'all 0.2s ease',
                      }}
                    />
                    {errors.name && (
                      <Typography level="body-xs" color="danger" sx={{ mt: 0.5 }}>
                        {errors.name.message}
                      </Typography>
                    )}
                  </FormControl>
                </CardContent>
              </Card>

              <Card
                variant="outlined"
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: mode === 'dark' ? grayAlpha[800][50] : 'background.surface',
                  transition: 'all 0.2s ease',
                  '&:hover': {
                    borderColor: 'primary.300',
                    boxShadow: mode === 'dark' ? `0 2px 8px ${blackAlpha[0][30]}` : `0 2px 8px ${blackAlpha[0][10]}`,
                  },
                }}
              >
                <CardContent>
                  <FormControl error={!!errors.description}>
                    <FormLabel sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 600 }}>
                      <Description sx={{ fontSize: 18, color: 'primary.500' }} />
                      Agent Description
                    </FormLabel>
                    <Textarea
                      {...register('description', {
                        required: 'Description is required',
                        minLength: {
                          value: 10,
                          message: 'Description must be at least 10 characters',
                        },
                      })}
                      placeholder="Describe what this agent specializes in and what kind of research it should focus on..."
                      minRows={3}
                      maxRows={5}
                      size="lg"
                      sx={{
                        '--Textarea-focusedThickness': '2px',
                        '--Textarea-focusedHighlight': blueAlpha[650][25],
                        transition: 'all 0.2s ease',
                      }}
                    />
                    {errors.description && (
                      <Typography level="body-xs" color="danger" sx={{ mt: 0.5 }}>
                        {errors.description.message}
                      </Typography>
                    )}
                  </FormControl>
                </CardContent>
              </Card>

              <Divider sx={{ my: 2 }} />

              <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', mt: 2 }}>
                <Button
                  variant="outlined"
                  color="neutral"
                  onClick={onClose}
                  disabled={isSubmitting}
                  size="md"
                  startDecorator={<Cancel />}
                  sx={{
                    minWidth: 100,
                    transition: 'all 0.2s ease',
                    '&:hover': {
                      transform: 'translateY(-1px)',
                      boxShadow: `0 4px 12px ${blackAlpha[0][15]}`,
                    },
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  loading={isSubmitting}
                  size="md"
                  startDecorator={!isSubmitting && <Save />}
                  sx={{
                    minWidth: 140,
                    background: `linear-gradient(135deg, ${blue[400]} 0%, ${brand[500]} 50%, ${purple[500]} 100%)`,
                    transition: 'all 0.2s ease',
                    '&:hover': {
                      transform: 'translateY(-1px)',
                      boxShadow: `0 8px 20px ${brandAlpha[500][40]}`,
                      background: `linear-gradient(135deg, ${blue[700]} 0%, ${blue[800]} 50%, ${purple[700]} 100%)`,
                    },
                    '&:active': {
                      transform: 'translateY(0px)',
                    },
                  }}
                >
                  {isEditMode ? '✨ Save Changes' : '🤖 Create Agent'}
                </Button>
              </Box>

              <Typography level="body-xs" color="neutral" sx={{ textAlign: 'center', mt: 1.5, fontStyle: 'italic' }}>
                {isEditMode
                  ? 'Your agent improvements will enhance future research capabilities'
                  : 'Your new AI agent will be ready to conduct intelligent research immediately!'}
              </Typography>
            </Stack>
          </form>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default ResearchAgentForm;
