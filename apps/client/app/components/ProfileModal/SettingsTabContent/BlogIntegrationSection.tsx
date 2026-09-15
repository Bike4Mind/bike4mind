import React, { useState } from 'react';
import { Typography, Button, Input, Stack, FormControl, FormLabel, Alert, Box, Grid } from '@mui/joy';
import { Article as BlogIcon, AutoAwesome } from '@mui/icons-material';
import { useUser } from '@client/app/contexts/UserContext';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import ContentPublishingModal from '../ContentPublishingModal';
import { useAdminTools } from '@client/app/hooks/useAdminTools';
import { getBlogHost } from '@client/app/utils/blogConfig';
import SectionContainer from '../SectionContainer';

const BlogIntegrationSection = () => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const { canUseAdminTools } = useAdminTools();

  const { data: blogSettings } = useQuery({
    queryKey: ['blog-integration'],
    queryFn: async () => {
      const response = await api.get('/api/blog-integration');
      return response.data;
    },
  });

  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(getBlogHost());
  const [defaultAuthor, setDefaultAuthor] = useState(currentUser?.name || '');
  const [defaultTags, setDefaultTags] = useState('');
  const [publishingModalOpen, setPublishingModalOpen] = useState(false);

  const isConnected = blogSettings?.connected || false;

  const saveBlogIntegration = useMutation({
    mutationFn: async (settings: {
      apiKey: string;
      baseUrl: string;
      defaultAuthor?: string;
      defaultTags?: string[];
    }) => {
      const response = await api.post('/api/blog-integration', settings);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blog-integration'] });
      queryClient.invalidateQueries({ queryKey: ['user'] });
      toast.success('Blog integration configured successfully!');
      setApiKey(''); // Clear API key from local state for security
    },
    onError: (error: any) => {
      console.error('Failed to save blog integration:', error);
      const message = error?.response?.data?.message || 'Failed to save blog settings';
      toast.error(message);
    },
  });

  const disconnectBlog = useMutation({
    mutationFn: async () => {
      const response = await api.delete('/api/blog-integration');
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blog-integration'] });
      queryClient.invalidateQueries({ queryKey: ['user'] });
      setApiKey('');
      setBaseUrl(getBlogHost());
      setDefaultAuthor(currentUser?.name || '');
      setDefaultTags('');
      toast.success('Blog integration disconnected successfully!');
    },
    onError: error => {
      console.error('Failed to disconnect blog:', error);
      toast.error('Failed to disconnect blog integration');
    },
  });

  const handleSave = () => {
    if (!apiKey) {
      toast.error('API key is required');
      return;
    }

    if (!baseUrl) {
      toast.error('Base URL is required');
      return;
    }

    const tagsArray = defaultTags
      ? defaultTags
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean)
      : [];

    saveBlogIntegration.mutate({
      apiKey,
      baseUrl,
      defaultAuthor: defaultAuthor || undefined,
      defaultTags: tagsArray.length > 0 ? tagsArray : undefined,
    });
  };

  // Only admins can access blog publishing features
  if (!canUseAdminTools) {
    return null;
  }

  return (
    <>
      <SectionContainer
        title={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <BlogIcon sx={{ fontSize: 32, color: 'primary.500' }} />
            <Typography level="h4" sx={{ fontSize: '16px' }}>
              Blog Publishing
            </Typography>
          </Box>
        }
        subtitle={
          isConnected
            ? `Connected${blogSettings?.settings?.baseUrl ? ` to ${blogSettings.settings.baseUrl}` : ''}`
            : 'Publish blog posts directly from conversations'
        }
        action={
          isConnected && (
            <span
              style={{
                color: 'var(--joy-palette-text-primary)',
                opacity: 0.5,
                textDecoration: 'underline',
                cursor: 'pointer',
                fontSize: '13px',
              }}
              onClick={() => {
                disconnectBlog.mutate();
              }}
            >
              Disconnect
            </span>
          )
        }
      >
        <Stack spacing={3}>
          {/* Setup Instructions */}
          {!isConnected && (
            <Alert
              color="primary"
              variant="soft"
              sx={theme => ({
                backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : undefined,
                alignSelf: 'flex-start',
                width: 'fit-content',
                p: 2,
              })}
            >
              <Box>
                <Typography level="body-sm" sx={{ color: 'text.primary', opacity: 0.5, mb: 1.5, fontWeight: 'bold' }}>
                  Setup Instructions:
                </Typography>
                <Stack spacing={1}>
                  <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                    1. Generate an API key from your blog admin panel
                  </Typography>
                  <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                    2. Enter your blog URL and API key below
                  </Typography>
                  <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                    3. Use &quot;Publish to my blog&quot; in conversations
                  </Typography>
                </Stack>
              </Box>
            </Alert>
          )}

          {/* Input Fields Row */}
          <Grid container spacing={2}>
            {/* Base URL Input */}
            <Grid xs={12} md={6}>
              <FormControl>
                <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>Blog URL</FormLabel>
                <Input
                  placeholder="https://blog.example.com"
                  value={baseUrl}
                  onChange={e => setBaseUrl(e.target.value)}
                  disabled={isConnected}
                  sx={{
                    width: '100%',
                    overflow: 'hidden',
                    backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                    '& input': {
                      backgroundColor: 'transparent',
                      color: 'text.primary',
                      fontSize: '14px',
                      '&::placeholder': {
                        color: 'text.primary',
                        opacity: 0.5,
                        fontSize: '14px',
                      },
                    },
                  }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                  Your blog&apos;s base URL (without trailing slash)
                </Typography>
              </FormControl>
            </Grid>

            {/* API Key Input */}
            <Grid xs={12} md={6}>
              <FormControl>
                <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>API Key</FormLabel>
                <Input
                  type="password"
                  placeholder={isConnected ? '••••••••' : 'Enter your blog API key'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  sx={{
                    width: '100%',
                    overflow: 'hidden',
                    backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                    '& input': {
                      backgroundColor: 'transparent',
                      color: 'text.primary',
                      fontSize: '14px',
                      '&::placeholder': {
                        color: 'text.primary',
                        opacity: 0.5,
                        fontSize: '14px',
                      },
                    },
                  }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                  {isConnected
                    ? `Connected with key: ${blogSettings?.settings?.apiKeyPreview}`
                    : 'Generate from your blog admin panel'}
                </Typography>
              </FormControl>
            </Grid>

            {/* Default Author */}
            <Grid xs={12} md={6}>
              <FormControl>
                <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>
                  Default Author (Optional)
                </FormLabel>
                <Input
                  placeholder="Your name"
                  value={defaultAuthor}
                  onChange={e => setDefaultAuthor(e.target.value)}
                  sx={{
                    width: '100%',
                    overflow: 'hidden',
                    backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                    '& input': {
                      backgroundColor: 'transparent',
                      color: 'text.primary',
                      fontSize: '14px',
                      '&::placeholder': {
                        color: 'text.primary',
                        opacity: 0.5,
                        fontSize: '14px',
                      },
                    },
                  }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                  Will be used as post author if not specified
                </Typography>
              </FormControl>
            </Grid>

            {/* Default Tags */}
            <Grid xs={12} md={6}>
              <FormControl>
                <FormLabel sx={{ userSelect: 'text', color: 'text.primary', opacity: 0.5 }}>
                  Default Tags (Optional)
                </FormLabel>
                <Input
                  placeholder="cycling, fitness, adventure"
                  value={defaultTags}
                  onChange={e => setDefaultTags(e.target.value)}
                  sx={{
                    width: '100%',
                    overflow: 'hidden',
                    backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                    '& input': {
                      backgroundColor: 'transparent',
                      color: 'text.primary',
                      fontSize: '14px',
                      '&::placeholder': {
                        color: 'text.primary',
                        opacity: 0.5,
                        fontSize: '14px',
                      },
                    },
                  }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                  Comma-separated tags to add to all posts
                </Typography>
              </FormControl>
            </Grid>
          </Grid>

          {/* Usage Instructions */}
          <Alert
            color="primary"
            variant="soft"
            sx={theme => ({
              backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : undefined,
              alignSelf: 'flex-start',
              width: 'fit-content',
              p: 2,
            })}
          >
            <Box>
              <Typography level="body-sm" sx={{ color: 'text.primary', opacity: 0.5, mb: 1.5, fontWeight: 'bold' }}>
                How to use:
              </Typography>
              <Stack spacing={1}>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • Create content in any conversation
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • Say &quot;Publish this to my blog&quot; or &quot;Post this to my blog&quot;
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • The AI will automatically publish using the <code>blog_publish</code> tool
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  • You can also specify: &quot;Save as draft&quot; to publish as draft
                </Typography>
              </Stack>
            </Box>
          </Alert>

          {/* Action Buttons */}
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <Button
              onClick={handleSave}
              loading={saveBlogIntegration.isPending}
              disabled={isConnected && !apiKey}
              sx={{ alignSelf: 'flex-start' }}
            >
              {isConnected ? 'Update Blog Settings' : 'Connect Blog'}
            </Button>

            {isConnected && (
              <Button
                variant="outlined"
                color="primary"
                onClick={() => setPublishingModalOpen(true)}
                startDecorator={<AutoAwesome />}
                sx={{ alignSelf: 'flex-start' }}
                data-testid="open-publishing-studio-btn"
              >
                Content Publishing Studio
              </Button>
            )}
          </Box>
        </Stack>
      </SectionContainer>

      {/* Content Publishing Studio Modal */}
      <ContentPublishingModal open={publishingModalOpen} onClose={() => setPublishingModalOpen(false)} />
    </>
  );
};

export default BlogIntegrationSection;
