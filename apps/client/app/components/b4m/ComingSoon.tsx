import { createFeedbackOnServer } from '@client/app/utils/feedbackAPICalls';
import { FeedbackStatus } from '@bike4mind/common';
import { APP_NAME } from '@client/config/general';
import { Box, Button, Input, Typography } from '@mui/joy';
import { useState } from 'react';
import { toast } from 'sonner';

const ComingSoon = () => {
  const [email, setEmail] = useState<string>('');

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  };

  const handleSubmit = async () => {
    if (!email) {
      toast.error('Please fill out all fields.');
      return;
    }

    await createFeedbackOnServer({
      userId: 'Unknown',
      userEmail: email,
      tags: ['comingSoon', 'marketing'],
      status: FeedbackStatus.New,
    });

    toast.success('Thank you! You will be notified when we launch.');
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: 2,
        px: 3,
        backgroundColor: 'background',
      }}
    >
      {/* brand name externalized to config */}
      <Typography level="h4">
        {APP_NAME ? `${APP_NAME} is coming soon!` : 'Coming soon!'} Enter your email to stay updated.
      </Typography>
      <Box
        component="form"
        sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', mt: 2 }}
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <Input
          placeholder="Your Email Address"
          type="email"
          value={email}
          onChange={handleEmailChange}
          sx={{ width: '100%', maxWidth: '400px' }}
        />
        <Button
          type="submit"
          sx={{ mt: 2, backgroundColor: 'primary', '&:hover': { backgroundColor: 'primary.dark' } }}
        >
          Notify Me
        </Button>
      </Box>
    </Box>
  );
};
export default ComingSoon;
