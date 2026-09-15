import ComingSoon from '@client/app/components/b4m/ComingSoon';
import { gray, blue, brand, cyan } from '../../utils/themes/colors';
import { ServerStatusEnum } from '@bike4mind/common';
import { Box, Typography, Button, LinearProgress, Stack, Card, IconButton } from '@mui/joy';
import React, { useState, useEffect } from 'react';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { APP_NAME } from '@client/config/general';
import { useTheme } from '@mui/joy/styles';

interface ComingSoonProps {
  customComingSoonContent?: React.ReactNode;
  serverStatus: ServerStatusEnum | undefined;
}

// Pedal Power Clicker Game Component
const PedalPowerGame: React.FC = () => {
  const [miles, setMiles] = useState(0);
  const [clickPower, setClickPower] = useState(1);
  const [autoMiles, setAutoMiles] = useState(0);
  const [achievements, setAchievements] = useState<string[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const [particles, setParticles] = useState<
    Array<{
      id: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
      rotation: number;
      createdAt: number;
    }>
  >([]);
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  // Auto-pedaling effect
  useEffect(() => {
    const interval = setInterval(() => {
      if (autoMiles > 0) {
        setMiles(prev => prev + autoMiles);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [autoMiles]);

  // Particle physics and cleanup
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setCurrentTime(now);
      setParticles(
        prev =>
          prev
            .map(particle => {
              const age = now - particle.createdAt;
              if (age > 7000) return null; // Remove after 7 seconds

              // Physics
              let newX = particle.x + particle.vx;
              let newY = particle.y + particle.vy;
              let newVx = particle.vx;
              let newVy = particle.vy + 0.5; // Gravity

              // Bounce off walls (assuming container is roughly 400px wide and 600px tall)
              if (newX <= 0 || newX >= 370) {
                newVx = -newVx * 0.8; // Energy loss on bounce
                newX = newX <= 0 ? 0 : 370;
              }
              if (newY <= 0 || newY >= 570) {
                newVy = -newVy * 0.8;
                newY = newY <= 0 ? 0 : 570;
              }

              return {
                ...particle,
                x: newX,
                y: newY,
                vx: newVx,
                vy: newVy,
              };
            })
            .filter(Boolean) as typeof prev
      );
    }, 16); // ~60fps

    return () => clearInterval(interval);
  }, []);

  // Achievement checking
  useEffect(() => {
    const newAchievements: string[] = [];
    if (miles >= 10 && !achievements.includes('First Mile')) {
      newAchievements.push('First Mile');
    }
    if (miles >= 100 && !achievements.includes('Century Rider')) {
      newAchievements.push('Century Rider');
    }
    if (miles >= 500 && !achievements.includes('Tour de Maintenance')) {
      newAchievements.push('Tour de Maintenance');
    }
    if (clickPower >= 5 && !achievements.includes('Power Legs')) {
      newAchievements.push('Power Legs');
    }

    if (newAchievements.length > 0) {
      setAchievements(prev => [...prev, ...newAchievements]);
    }
  }, [miles, clickPower, achievements]);

  const handlePedal = () => {
    setMiles(prev => prev + clickPower);
    setIsAnimating(true);
    setTimeout(() => setIsAnimating(false), 150);

    // Create particle effect!
    const newParticle = {
      id: Date.now() + Math.random(),
      x: 200, // Center of button area
      y: 200,
      vx: (Math.random() - 0.5) * 20, // Random horizontal velocity
      vy: Math.random() * -15 - 5, // Random upward velocity
      rotation: Math.random() * 360,
      createdAt: Date.now(),
    };

    setParticles(prev => [...prev, newParticle]);
  };

  const buyUpgrade = (type: 'power' | 'auto') => {
    if (type === 'power' && miles >= clickPower * 10) {
      setMiles(prev => prev - clickPower * 10);
      setClickPower(prev => prev + 1);
    } else if (type === 'auto' && miles >= (autoMiles + 1) * 50) {
      setMiles(prev => prev - (autoMiles + 1) * 50);
      setAutoMiles(prev => prev + 1);
    }
  };

  return (
    <Card
      variant="outlined"
      sx={{ p: 3, maxWidth: 400, width: '100%', mt: 3, position: 'relative', overflow: 'hidden' }}
    >
      {/* Particle Effects */}
      {particles.map(particle => {
        const age = currentTime - particle.createdAt;
        const opacity = Math.max(0, 1 - age / 7000); // Fade out over 7 seconds

        return (
          <Box
            key={particle.id}
            sx={{
              position: 'absolute',
              left: particle.x,
              top: particle.y,
              transform: `rotate(${particle.rotation}deg)`,
              opacity,
              pointerEvents: 'none',
              zIndex: 10,
            }}
          >
            <Bike4MindIcon size="16" fill="currentColor" />
          </Box>
        );
      })}

      <Typography level="h4" sx={{ textAlign: 'center', mb: 2 }}>
        🚴 Pedal Power Challenge
      </Typography>

      <Typography level="body-md" sx={{ textAlign: 'center', mb: 2 }}>
        Keep pedaling while we tune up the servers!
      </Typography>

      <Box sx={{ textAlign: 'center', mb: 3 }}>
        <Typography level="h2" sx={{ color: 'primary.500', fontWeight: 'bold' }}>
          {miles.toFixed(1)} miles
        </Typography>
        <Typography level="body-sm" sx={{ opacity: 0.7 }}>
          {clickPower > 1 && `+${clickPower} per click`} {autoMiles > 0 && `+${autoMiles}/sec auto`}
        </Typography>
      </Box>

      {/* Main Pedal Button */}
      <IconButton
        variant="solid"
        color="primary"
        size="lg"
        onClick={handlePedal}
        sx={{
          width: 120,
          height: 120,
          borderRadius: '50%',
          mx: 'auto',
          mb: 3,
          transform: isAnimating ? 'scale(0.95)' : 'scale(1)',
          transition: 'transform 0.15s ease',
          '&:hover': {
            transform: 'scale(1.05)',
          },
        }}
      >
        <Bike4MindIcon size="48" fill="white" />
      </IconButton>

      {/* Upgrades */}
      <Stack spacing={1}>
        <Button variant="outlined" size="sm" disabled={miles < clickPower * 10} onClick={() => buyUpgrade('power')}>
          🦵 Stronger Legs - {clickPower * 10} miles
        </Button>
        <Button variant="outlined" size="sm" disabled={miles < (autoMiles + 1) * 50} onClick={() => buyUpgrade('auto')}>
          🤖 Auto-Pedal - {(autoMiles + 1) * 50} miles
        </Button>
      </Stack>

      {/* Achievements */}
      {achievements.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography level="body-sm" sx={{ fontWeight: 'bold', mb: 1 }}>
            🏆 Achievements:
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {achievements.map((achievement, index) => (
              <Typography
                key={index}
                level="body-xs"
                sx={{
                  px: 1,
                  py: 0.5,
                  borderRadius: 'sm',
                  backgroundColor: 'primary.100',
                  color: 'primary.800',
                }}
              >
                {achievement}
              </Typography>
            ))}
          </Box>
        </Box>
      )}
    </Card>
  );
};

/**
 * A component that shows whether the server is in maintenance mode or coming soon(offline).
 */
const MaintenanceComingSoonPage: React.FC<ComingSoonProps> = ({
  customComingSoonContent = <ComingSoon />,
  serverStatus,
}) => {
  const theme = useTheme();
  const mode = theme.palette.mode;

  // If the server is in maintenance mode, show the maintenance page
  if (serverStatus === ServerStatusEnum.Maintenance) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          px: 3,
          py: { xs: 4, md: 2 },
          background:
            mode === 'dark'
              ? `linear-gradient(135deg, ${gray[900]} 0%, ${gray[865]} 100%)`
              : `linear-gradient(135deg, ${gray[50]} 0%, ${gray[55]} 100%)`,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Animated Background Elements */}
        <Box
          sx={{
            position: 'absolute',
            top: '10%',
            left: '10%',
            width: 100,
            height: 100,
            borderRadius: '50%',
            background: `linear-gradient(45deg, ${blue[600]}, ${cyan[300]})`,
            opacity: 0.1,
            animation: 'float 6s ease-in-out infinite',
            '@keyframes float': {
              '0%, 100%': { transform: 'translateY(0px)' },
              '50%': { transform: 'translateY(-20px)' },
            },
          }}
        />
        <Box
          sx={{
            position: 'absolute',
            top: '70%',
            right: '15%',
            width: 60,
            height: 60,
            borderRadius: '50%',
            background: `linear-gradient(45deg, ${cyan[300]}, ${brand[600]})`,
            opacity: 0.1,
            animation: 'float 8s ease-in-out infinite reverse',
          }}
        />

        {/* Main Container - Responsive Layout */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: { xs: 'center', md: 'flex-start' },
            justifyContent: 'center',
            gap: { xs: 3, md: 6 },
            maxWidth: 1200,
            width: '100%',
          }}
        >
          {/* Left Side - Main Content */}
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              maxWidth: { xs: '100%', md: 600 },
            }}
          >
            {/* Logo */}
            <Box sx={{ mb: 2 }}>
              <Box
                component="img"
                src="/icons/Colored_Logo_Clean.svg"
                /* brand externalized */
                alt={APP_NAME ? `${APP_NAME} Logo` : 'Logo'}
                sx={{
                  width: { xs: 100, md: 120 },
                  height: 'auto',
                  filter: mode === 'dark' ? 'brightness(1.1)' : 'none',
                }}
              />
            </Box>

            {/* Main Title */}
            <Typography
              level="h1"
              sx={{
                textAlign: 'center',
                background: `linear-gradient(45deg, ${blue[600]}, ${cyan[300]})`,
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                fontWeight: 'bold',
                fontSize: { xs: '1.8rem', md: '2.5rem' },
                mb: 1,
              }}
            >
              Grinding Perfection
            </Typography>

            {/* Subtitle */}
            <Typography
              level="h4"
              sx={{
                textAlign: 'center',
                opacity: 0.8,
                lineHeight: 1.4,
                mb: 2,
                fontSize: { xs: '1.1rem', md: '1.3rem' },
              }}
            >
              Our human and AI minds are getting a tune-up!
            </Typography>

            {/* Snappy Copy */}
            <Stack spacing={1} sx={{ textAlign: 'center', mb: 3 }}>
              <Typography level="body-lg" sx={{ opacity: 0.9 }}>
                🚀 <strong>Upgrading our neural networks</strong>
              </Typography>
              <Typography level="body-lg" sx={{ opacity: 0.9 }}>
                🔧 <strong>Fine-tuning the knowledge engines</strong>
              </Typography>
              <Typography level="body-lg" sx={{ opacity: 0.9 }}>
                ⚡ <strong>Installing productivity superpowers</strong>
              </Typography>
            </Stack>

            {/* Progress Bar */}
            <Box sx={{ width: '100%', maxWidth: 400, mb: 3 }}>
              <LinearProgress
                variant="solid"
                color="primary"
                sx={{
                  height: 8,
                  borderRadius: 'lg',
                  '--LinearProgress-progressThickness': '8px',
                  animation: 'progress 3s ease-in-out infinite',
                  '@keyframes progress': {
                    '0%': { '--LinearProgress-percent': '65' },
                    '50%': { '--LinearProgress-percent': '85' },
                    '100%': { '--LinearProgress-percent': '95' },
                  },
                }}
              />
              <Typography level="body-sm" sx={{ textAlign: 'center', mt: 1, opacity: 0.7 }}>
                Optimization in progress... Almost there!
              </Typography>
            </Box>

            {/* ETA */}
            <Typography level="body-sm" sx={{ opacity: 0.6, textAlign: 'center', mb: { xs: 2, md: 3 } }}>
              We&apos;ll be back faster than Reddit can align on the definition of &quot;Consciousness&quot;.
            </Typography>

            {/* Social Proof */}
            <Box
              sx={{
                p: 2,
                borderRadius: 'lg',
                backgroundColor: theme => theme.palette.common.overlay.subtleBackground,
                border: '1px solid',
                borderColor: theme => theme.palette.common.overlay.subtleBorder,
                maxWidth: 400,
              }}
            >
              <Typography level="body-sm" sx={{ textAlign: 'center', fontStyle: 'italic' }}>
                &quot;Clicking is so Zen...&quot;
                <br />
                <span style={{ opacity: 0.7 }}>- Anonymous</span>
              </Typography>
            </Box>
          </Box>

          {/* Right Side - Game (Desktop) / Below (Mobile) */}
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: { xs: 'center', md: 'flex-start' },
              pt: { xs: 0, md: 4 }, // Add some top padding on desktop to align better
            }}
          >
            <PedalPowerGame />
          </Box>
        </Box>
      </Box>
    );
  }

  // Else, show the coming soon page
  return customComingSoonContent;
};

export default MaintenanceComingSoonPage;
