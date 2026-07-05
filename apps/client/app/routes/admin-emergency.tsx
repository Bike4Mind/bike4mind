import React, { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Box, Card, Typography, FormControl, FormLabel, Input, Button, Alert, Stack, IconButton } from '@mui/joy';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { api } from '@client/app/contexts/ApiContext';

const AdminEmergencyPage = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const { currentUser, setCurrentUser } = useUser();

  // If already logged in as admin, redirect to admin panel
  useEffect(() => {
    if (currentUser?.isAdmin) {
      navigate({ to: '/admin', search: { emergency_access: 'true' } });
    }
  }, [currentUser, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      const response = await api.post('/api/admin/emergency-login', {
        username,
        password,
      });

      if (response.data.success) {
        const userData = response.data.user;

        // Extract tokens from user data (they're embedded by the backend)
        const { accessToken, refreshToken, ...userWithoutTokens } = userData;

        console.log('🔐 Emergency login tokens extracted:', {
          hasAccessToken: !!accessToken,
          hasRefreshToken: !!refreshToken,
        });

        // Store tokens in useAccessToken store (CRITICAL for API calls)
        useAccessToken.getState().setVerifiedTokens(accessToken, refreshToken);

        // Set user context (without embedded tokens)
        setCurrentUser(userWithoutTokens);

        // Log emergency access
        console.log('🚨 Emergency admin access used:', {
          user: username,
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent,
        });

        navigate({ to: '/admin', search: { emergency_access: 'true' } });
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Invalid credentials or not an admin user');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0E1214 0%, #1A2332 100%)',
        padding: 2,
      }}
    >
      <Card
        variant="outlined"
        sx={{
          maxWidth: 400,
          width: '100%',
          padding: 4,
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          backdropFilter: 'blur(10px)',
        }}
      >
        {/* Header */}
        <Stack spacing={2} alignItems="center" sx={{ mb: 3 }}>
          <Box
            sx={{
              p: 1.5,
              borderRadius: '50%',
              backgroundColor: 'rgba(255, 107, 107, 0.1)',
              border: '2px solid rgba(255, 107, 107, 0.3)',
            }}
          >
            <ShieldOutlinedIcon sx={{ fontSize: 32, color: '#ff6b6b' }} />
          </Box>

          <Typography level="h2" sx={{ color: 'white', textAlign: 'center' }}>
            🚨 Emergency Admin Access
          </Typography>

          <Alert
            variant="soft"
            color="warning"
            startDecorator={<WarningAmberOutlinedIcon sx={{ fontSize: 16 }} />}
            sx={{ width: '100%' }}
          >
            <Typography level="body-sm">
              This bypass is for emergency maintenance access only. All usage is logged and audited.
            </Typography>
          </Alert>
        </Stack>

        {/* Login Form */}
        <form onSubmit={handleLogin}>
          <Stack spacing={3}>
            <FormControl required>
              <FormLabel sx={{ color: 'white' }}>Username</FormLabel>
              <Input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Enter admin username"
                disabled={isLoading}
                sx={{
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: 'white',
                  '&::placeholder': { color: 'rgba(255, 255, 255, 0.5)' },
                }}
              />
            </FormControl>

            <FormControl required>
              <FormLabel sx={{ color: 'white' }}>Password</FormLabel>
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter admin password"
                disabled={isLoading}
                endDecorator={
                  <IconButton
                    variant="plain"
                    color="neutral"
                    onClick={() => setShowPassword(!showPassword)}
                    sx={{ color: 'white' }}
                  >
                    {showPassword ? (
                      <VisibilityOffOutlinedIcon sx={{ fontSize: 16 }} />
                    ) : (
                      <VisibilityOutlinedIcon sx={{ fontSize: 16 }} />
                    )}
                  </IconButton>
                }
                sx={{
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: 'white',
                  '&::placeholder': { color: 'rgba(255, 255, 255, 0.5)' },
                }}
              />
            </FormControl>

            {error && (
              <Alert variant="soft" color="danger">
                <Typography level="body-sm">{error}</Typography>
              </Alert>
            )}

            <Button
              type="submit"
              loading={isLoading}
              disabled={!username || !password}
              sx={{
                background: 'linear-gradient(45deg, #ff6b6b, #ee5a5a)',
                '&:hover': {
                  background: 'linear-gradient(45deg, #ee5a5a, #dd4b4b)',
                },
              }}
            >
              Emergency Login
            </Button>
          </Stack>
        </form>

        {/* Footer */}
        <Typography
          level="body-xs"
          sx={{
            textAlign: 'center',
            mt: 3,
            color: 'rgba(255, 255, 255, 0.6)',
            fontStyle: 'italic',
          }}
        >
          Security Note: This emergency access is monitored and logged.
          <br />
          Return to normal login after resolving the emergency.
        </Typography>
      </Card>
    </Box>
  );
};

export default AdminEmergencyPage;
