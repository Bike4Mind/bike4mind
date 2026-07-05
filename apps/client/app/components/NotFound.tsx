import React from 'react';
import { Box, Button, Container, Stack, Typography } from '@mui/joy';
import Image from 'next/image';
import { useNavigate } from '@tanstack/react-router';
import useGetLogo from '../hooks/useGetLogo';

const NotFound: React.FC = () => {
  const navigate = useNavigate();
  const logoUrl = useGetLogo();

  return (
    <Container
      data-testid="notfound-page"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        maxWidth: '90vw',
        mx: 'auto',
        pb: '20vh',
      }}
    >
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          margin: '1rem 0',
        }}
      >
        <Box sx={{ position: 'relative', width: 140, height: 100 }}>
          <Image
            src={logoUrl}
            alt="Logo"
            fill
            style={{
              objectFit: 'contain',
            }}
          />
        </Box>
        <Stack
          spacing={3}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            width: '100%',
            maxWidth: '500px',
            mx: 'auto',
            mt: 4,
          }}
        >
          <Typography level="h1">Page not found</Typography>
          <Typography level="body-md">The page you’re looking for doesn’t exist or has moved.</Typography>
          <Button data-testid="notfound-home-btn" onClick={() => navigate({ to: '/' })}>
            Back to home
          </Button>
        </Stack>
      </Box>
    </Container>
  );
};

export default NotFound;
