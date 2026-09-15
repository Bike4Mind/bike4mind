import { useState, useEffect } from 'react';
import { Box, Button, Card, CircularProgress, Divider, Sheet, Stack, Typography, Alert } from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { useSearch } from '@tanstack/react-router';
import { EmailCategory } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

interface PreferencesData {
  email: string;
  preferences: {
    unsubscribedCategories: EmailCategory[];
    globalUnsubscribe: boolean;
  };
  categories: EmailCategory[];
}

const CATEGORY_LABELS: Record<EmailCategory, string> = {
  [EmailCategory.MARKETING]: 'Marketing',
  [EmailCategory.PRODUCT_UPDATE]: 'Product Updates',
  [EmailCategory.NEWSLETTER]: 'Newsletter',
  [EmailCategory.ANNOUNCEMENT]: 'Announcements',
  [EmailCategory.TRANSACTIONAL]: 'Transactional',
};

const CATEGORY_DESCRIPTIONS: Record<EmailCategory, string> = {
  [EmailCategory.MARKETING]: 'Promotional offers and special deals',
  [EmailCategory.PRODUCT_UPDATE]: 'New features and improvements',
  [EmailCategory.NEWSLETTER]: 'Weekly digest and curated content',
  [EmailCategory.ANNOUNCEMENT]: 'Important announcements about the service',
  [EmailCategory.TRANSACTIONAL]: 'Account-related notifications (password resets, etc.)',
};

export default function UnsubscribePage() {
  const search = useSearch({ strict: false }) as { token?: string };
  const token = search.token;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PreferencesData | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('No unsubscribe token provided. Please use the link from your email.');
      setLoading(false);
      return;
    }

    const fetchPreferences = async () => {
      try {
        const response = await api.get('/api/email/unsubscribe', { params: { token } });
        setData(response.data);
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to load preferences. The link may be invalid or expired.');
      } finally {
        setLoading(false);
      }
    };

    fetchPreferences();
  }, [token]);

  const handleUnsubscribeCategory = async (category: EmailCategory) => {
    if (!token) return;
    setProcessing(true);
    setSuccessMessage(null);

    try {
      const response = await api.post('/api/email/unsubscribe', { category }, { params: { token } });
      setSuccessMessage(response.data.message);
      if (data) {
        setData({
          ...data,
          preferences: {
            ...data.preferences,
            unsubscribedCategories: [...data.preferences.unsubscribedCategories, category],
          },
        });
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update preferences');
    } finally {
      setProcessing(false);
    }
  };

  const handleGlobalUnsubscribe = async () => {
    if (!token) return;
    setProcessing(true);
    setSuccessMessage(null);

    try {
      const response = await api.post('/api/email/unsubscribe', { globalUnsubscribe: true }, { params: { token } });
      setSuccessMessage(response.data.message);
      if (data) {
        setData({
          ...data,
          preferences: {
            ...data.preferences,
            globalUnsubscribe: true,
          },
        });
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update preferences');
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          bgcolor: 'background.surface',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error && !data) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          bgcolor: 'background.surface',
          p: 2,
        }}
      >
        <Card sx={{ maxWidth: 500, width: '100%', textAlign: 'center', p: 4 }}>
          <ErrorIcon color="error" sx={{ fontSize: 48, mb: 2 }} />
          <Typography level="h4" sx={{ mb: 2 }}>
            Unable to Load Preferences
          </Typography>
          <Typography level="body-md" sx={{ color: 'neutral.600' }}>
            {error}
          </Typography>
        </Card>
      </Box>
    );
  }

  if (data?.preferences.globalUnsubscribe) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          bgcolor: 'background.surface',
          p: 2,
        }}
      >
        <Card sx={{ maxWidth: 500, width: '100%', textAlign: 'center', p: 4 }}>
          <CheckCircleIcon color="success" sx={{ fontSize: 48, mb: 2 }} />
          <Typography level="h4" sx={{ mb: 2 }}>
            You&apos;re Unsubscribed
          </Typography>
          <Typography level="body-md" sx={{ color: 'neutral.600' }}>
            {data.email} has been unsubscribed from all marketing emails.
          </Typography>
          <Typography level="body-sm" sx={{ color: 'neutral.500', mt: 2 }}>
            You may still receive important transactional emails about your account.
          </Typography>
        </Card>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        bgcolor: 'background.surface',
        p: 2,
      }}
    >
      <Card sx={{ maxWidth: 600, width: '100%', p: 4 }}>
        <Typography level="h3" sx={{ mb: 1 }}>
          Email Preferences
        </Typography>
        <Typography level="body-md" sx={{ color: 'neutral.600', mb: 3 }}>
          Manage email subscriptions for <strong>{data?.email}</strong>
        </Typography>

        {successMessage && (
          <Alert color="success" sx={{ mb: 3 }} startDecorator={<CheckCircleIcon />}>
            {successMessage}
          </Alert>
        )}

        {error && (
          <Alert color="danger" sx={{ mb: 3 }} startDecorator={<ErrorIcon />}>
            {error}
          </Alert>
        )}

        <Typography level="title-md" sx={{ mb: 2 }}>
          Email Categories
        </Typography>

        <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
          <Stack divider={<Divider />}>
            {data?.categories
              .filter(cat => cat !== EmailCategory.TRANSACTIONAL)
              .map(category => {
                const isUnsubscribed = data.preferences.unsubscribedCategories.includes(category);
                return (
                  <Box
                    key={category}
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      p: 2,
                      bgcolor: isUnsubscribed ? 'neutral.50' : 'transparent',
                    }}
                  >
                    <Box>
                      <Typography level="title-sm">{CATEGORY_LABELS[category]}</Typography>
                      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                        {CATEGORY_DESCRIPTIONS[category]}
                      </Typography>
                    </Box>
                    {isUnsubscribed ? (
                      <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
                        Unsubscribed
                      </Typography>
                    ) : (
                      <Button
                        size="sm"
                        variant="soft"
                        color="neutral"
                        onClick={() => handleUnsubscribeCategory(category)}
                        loading={processing}
                        data-testid={`unsubscribe-${category}`}
                      >
                        Unsubscribe
                      </Button>
                    )}
                  </Box>
                );
              })}
          </Stack>
        </Sheet>

        <Divider sx={{ my: 3 }} />

        <Box sx={{ textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: 'neutral.600', mb: 2 }}>
            Want to stop receiving all marketing emails?
          </Typography>
          <Button
            variant="outlined"
            color="danger"
            onClick={handleGlobalUnsubscribe}
            loading={processing}
            data-testid="global-unsubscribe"
          >
            Unsubscribe from All
          </Button>
        </Box>

        <Typography level="body-xs" sx={{ color: 'neutral.500', mt: 3, textAlign: 'center' }}>
          Note: Transactional emails (password resets, account notifications) cannot be disabled.
        </Typography>
      </Card>
    </Box>
  );
}
