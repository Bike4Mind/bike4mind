import React, { useState } from 'react';
import { Stack, Input, Button, Typography, Box, FormLabel } from '@mui/joy';
import { createSubscriber } from '@client/app/utils/subscriberAPICalls';
import { useCommonStyles } from '../hooks/useCommonStyles';
import { useTheme } from '@mui/joy/styles';
import { gray } from '@client/app/utils/themes/colors';

const SubscriberForm = () => {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
  });
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState('');

  const { inputStyles } = useCommonStyles();
  const theme = useTheme();
  const mode = theme.palette.mode;
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      await createSubscriber(formData);
      setIsSubmitted(true);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Something went wrong. Please try again.');
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

  const inputFields = [
    { name: 'firstName', label: 'First Name', type: 'text' },
    { name: 'lastName', label: 'Last Name', type: 'text' },
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
