import React, { useState } from 'react';
import { Stack, Input, Button, Typography, Box, FormLabel } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { createSubscriber } from '@client/app/utils/subscriberAPICalls';
import { solveTurnstileIfRequired } from '@client/app/hooks/data/auth';
import { useCommonStyles } from '../hooks/useCommonStyles';
import { useTheme } from '@mui/joy/styles';
import { gray } from '@client/app/utils/themes/colors';
import { TURNSTILE_ACTION_SUBSCRIBE, type SubscriberSource } from '@bike4mind/common';

type SubscriberFormProps = {
  initialEmail?: string;
  source?: SubscriberSource;
};

const FALLBACK_ERROR = 'Something went wrong. Please try again.';

// The API answers every refusal (challenge, rate limit, validation) with `error`; a failed challenge
// never reaches the API and arrives as a plain Error carrying the message to show.
function submitErrorMessage(err: unknown): string {
  if (isAxiosError(err)) {
    const data: unknown = err.response?.data;
    if (data && typeof data === 'object') {
      const { error, message } = data as { error?: unknown; message?: unknown };
      if (typeof error === 'string' && error) return error;
      if (typeof message === 'string' && message) return message;
    }
    return FALLBACK_ERROR;
  }
  return err instanceof Error && err.message ? err.message : FALLBACK_ERROR;
}

const SubscriberForm = ({ initialEmail = '', source }: SubscriberFormProps) => {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: initialEmail,
  });
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const { inputStyles } = useCommonStyles();
  const theme = useTheme();
  const mode = theme.palette.mode;
  const queryClient = useQueryClient();
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      const turnstileToken = await solveTurnstileIfRequired(queryClient, TURNSTILE_ACTION_SUBSCRIBE);
      await createSubscriber({ ...formData, source, turnstileToken });
      setIsSubmitted(true);
    } catch (err: unknown) {
      setError(submitErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
    return (
      <Typography level="h3" textAlign="center" sx={{ color: 'text.primary' }}>
        Thanks for being interested! We&apos;ll be in touch soon.
      </Typography>
    );
  }

  const styles = {
    formLabel: {
      mb: 1,
      display: 'block',
      color: gray[653],
      fontWeight: 400,
    },
  };

  const inputFields: { name: string; label: string; type: string; maxLength?: number }[] = [
    { name: 'firstName', label: 'First Name', type: 'text', maxLength: 50 },
    { name: 'lastName', label: 'Last Name', type: 'text', maxLength: 50 },
    { name: 'email', label: 'Email', type: 'email' },
  ];

  return (
    <form onSubmit={handleSubmit}>
      <Box display="flex" flexDirection={'column'} gap={2}>
        <Stack
          spacing={{ xs: 2, sm: 4 }}
          width="100%"
          direction={{ xs: 'column', sm: 'row' }}
          sx={{
            justifyContent: 'space-between',
            mb: 2,
            maxWidth: '900px',
          }}
        >
          {inputFields.map(field => (
            <Box key={field.name} sx={{ width: { xs: '100%', sm: 'auto' } }}>
              <FormLabel sx={{ ...styles.formLabel, color: mode === 'light' ? gray[653] : undefined }}>
                {field.label}
              </FormLabel>
              <Input
                required
                type={field.type}
                slotProps={{
                  input: { 'data-testid': `subscriber-form-${field.name}-input`, maxLength: field.maxLength },
                }}
                value={formData[field.name as keyof typeof formData]}
                onChange={e => setFormData(prev => ({ ...prev, [field.name]: e.target.value }))}
                sx={{
                  ...inputStyles,
                  width: { xs: '100%', sm: '280px' },
                  height: '36px',
                }}
              />
            </Box>
          ))}
        </Stack>
        {error && (
          <Typography color="danger" fontSize="sm" sx={{ textAlign: 'center' }}>
            {error}
          </Typography>
        )}
        <Box display="flex" justifyContent="center">
          <Button
            type="submit"
            size="lg"
            loading={isSubmitting}
            data-testid="subscriber-form-submit-btn"
            sx={{
              width: { xs: '100%', sm: '220px' },
              height: '40px',
              fontWeight: 500,
            }}
          >
            Subscribe
          </Button>
        </Box>
      </Box>
    </form>
  );
};

export default SubscriberForm;
