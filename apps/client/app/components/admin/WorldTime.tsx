import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Box,
  Card,
  Grid,
  Stack,
  Typography,
  IconButton,
  Button,
  Input,
  Modal,
  ModalDialog,
  ModalClose,
  Sheet,
  Chip,
} from '@mui/joy';
import {
  WbSunny as SunIcon,
  NightsStay as MoonIcon,
  Add as AddIcon,
  Close as CloseIcon,
  Search as SearchIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  Schedule as ClockIcon,
  CalendarToday as CalendarIcon,
  Language as GlobeIcon,
} from '@mui/icons-material';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import { motion, AnimatePresence } from 'framer-motion';
import { keyframes, styled } from '@mui/system';
import { WORLD_CITIES } from './worldCities';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

dayjs.extend(timezone);
dayjs.extend(utc);
dayjs.extend(advancedFormat);

// Styled components
const GlowingCard = styled(motion.div)<{ glowColor: string; isDaytime: boolean }>`
  position: relative;
  border-radius: 24px;
  overflow: hidden;
  backdrop-filter: blur(20px);
  background: ${props =>
    props.isDaytime
      ? 'linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.7) 100%)'
      : 'linear-gradient(135deg, rgba(20,20,40,0.95) 0%, rgba(40,40,80,0.85) 100%)'};
  box-shadow: ${props => `
    0 8px 32px rgba(0,0,0,0.1),
    0 0 80px ${props.glowColor}20,
    inset 0 0 60px ${props.glowColor}10
  `};
  transition: all 0.6s cubic-bezier(0.4, 0, 0.2, 1);

  &:hover {
    transform: translateY(-8px) scale(1.02);
    box-shadow: ${props => `
      0 20px 60px rgba(0,0,0,0.2),
      0 0 120px ${props.glowColor}40,
      inset 0 0 80px ${props.glowColor}20
    `};
  }

  &::before {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: radial-gradient(circle at center, ${props => props.glowColor}20 0%, transparent 70%);
    opacity: 0;
    transition: opacity 0.6s ease;
    pointer-events: none;
  }

  &:hover::before {
    opacity: 1;
  }
`;

const float = keyframes`
  0%, 100% { transform: translateY(0px) rotate(0deg); }
  25% { transform: translateY(-10px) rotate(1deg); }
  75% { transform: translateY(5px) rotate(-1deg); }
`;

const pulse = keyframes`
  0%, 100% { opacity: 0.8; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.05); }
`;

const SunMoonContainer = styled(motion.div)`
  position: absolute;
  top: 20px;
  right: 20px;
  width: 60px;
  height: 60px;
  animation: ${float} 6s ease-in-out infinite;
`;

const BackgroundGradient = styled('div')<{ isDaytime: boolean }>`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: ${(props: { isDaytime: boolean }) =>
    props.isDaytime
      ? 'radial-gradient(ellipse at top, #87CEEB 0%, #98D8E8 50%, #F0E68C 100%)'
      : 'radial-gradient(ellipse at top, #0a0a2a 0%, #16213e 50%, #1a1a3a 100%)'};
  transition: background 2s ease;
  z-index: 0;
  pointer-events: none;
`;

const StarsContainer = styled('div')`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 0;
`;

const Star = styled('div')<{ size: number; top: number; left: number; delay: number }>`
  position: absolute;
  width: ${(props: { size: number }) => props.size}px;
  height: ${(props: { size: number }) => props.size}px;
  background: white;
  border-radius: 50%;
  top: ${(props: { top: number }) => props.top}%;
  left: ${(props: { left: number }) => props.left}%;
  animation: ${pulse} ${(props: { delay: number }) => 2 + props.delay}s ease-in-out infinite;
  animation-delay: ${(props: { delay: number }) => props.delay}s;
  box-shadow: 0 0 ${(props: { size: number }) => props.size * 2}px white;
`;

// Timezone data with metadata
interface CityData {
  id: string;
  timezone: string;
  name: string;
  country: string;
  countryCode?: string;
  lat: number;
  lng: number;
  emoji: string;
  isFavorite?: boolean;
}

const defaultCities: CityData[] = [
  {
    id: 'austin',
    timezone: 'America/Chicago',
    name: 'Austin',
    country: 'USA',
    lat: 30.2672,
    lng: -97.7431,
    emoji: '🤠',
  },
  {
    id: 'cebu',
    timezone: 'Asia/Manila',
    name: 'Cebu',
    country: 'Philippines',
    lat: 10.3157,
    lng: 123.8854,
    emoji: '🏝️',
  },
  { id: 'kyiv', timezone: 'Europe/Kiev', name: 'Kyiv', country: 'Ukraine', lat: 50.4501, lng: 30.5234, emoji: '🌻' },
  {
    id: 'louisville',
    timezone: 'America/New_York',
    name: 'Louisville',
    country: 'USA',
    lat: 38.2527,
    lng: -85.7585,
    emoji: '🐎',
  },
];

// Curated world cities dataset
const allCities: CityData[] = WORLD_CITIES;

// Common timezone abbreviation mapping to IANA zones
const tzAbbreviationToZones: Record<string, string[]> = {
  PST: ['America/Los_Angeles'],
  PDT: ['America/Los_Angeles'],
  MST: ['America/Denver'],
  MDT: ['America/Denver'],
  CST: ['America/Chicago'],
  CDT: ['America/Chicago'],
  EST: ['America/New_York'],
  EDT: ['America/New_York'],
  HST: ['Pacific/Honolulu'],
  AKST: ['America/Anchorage'],
  AKDT: ['America/Anchorage'],
  GMT: ['Europe/London'],
  BST: ['Europe/London'],
  WET: ['Europe/Lisbon', 'Atlantic/Canary'],
  WEST: ['Europe/Lisbon', 'Atlantic/Canary'],
  CET: [
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Madrid',
    'Europe/Vienna',
    'Europe/Stockholm',
    'Europe/Warsaw',
    'Europe/Rome',
  ],
  CEST: [
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Madrid',
    'Europe/Vienna',
    'Europe/Stockholm',
    'Europe/Warsaw',
    'Europe/Rome',
  ],
  EET: ['Europe/Athens', 'Europe/Kiev', 'Africa/Cairo'],
  EEST: ['Europe/Athens', 'Europe/Kiev', 'Africa/Cairo'],
  MSK: ['Europe/Moscow'],
  AST: ['Asia/Riyadh', 'America/Halifax'],
  GST: ['Asia/Dubai'],
  IST: ['Asia/Kolkata'],
  PKT: ['Asia/Karachi'],
  BDT: ['Asia/Dhaka'],
  ICT: ['Asia/Bangkok'],
  HKT: ['Asia/Hong_Kong'],
  SGT: ['Asia/Singapore'],
  JST: ['Asia/Tokyo'],
  KST: ['Asia/Seoul'],
  AEST: ['Australia/Sydney'],
  AEDT: ['Australia/Sydney'],
  NZST: ['Pacific/Auckland'],
  NZDT: ['Pacific/Auckland'],
};

// Helper functions
const getSunPosition = (date: dayjs.Dayjs, lat: number, lng: number) => {
  const dayOfYear = date.diff(date.startOf('year'), 'day');
  const hour = date.hour() + date.minute() / 60;

  // Simplified sun position calculation
  const declination = 23.45 * Math.sin((((360 * (284 + dayOfYear)) / 365) * Math.PI) / 180);
  const hourAngle = 15 * (hour - 12);
  const altitude =
    (Math.asin(
      Math.sin((lat * Math.PI) / 180) * Math.sin((declination * Math.PI) / 180) +
        Math.cos((lat * Math.PI) / 180) *
          Math.cos((declination * Math.PI) / 180) *
          Math.cos((hourAngle * Math.PI) / 180)
    ) *
      180) /
    Math.PI;

  return altitude;
};

const getTimeOfDay = (hour: number): 'night' | 'dawn' | 'morning' | 'afternoon' | 'dusk' => {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 19) return 'dusk';
  return 'night';
};

const getGradientColors = (timeOfDay: string) => {
  const gradients = {
    night: ['#0a0a2a', '#16213e', '#1a1a3a'],
    dawn: ['#FF6B6B', '#FF8E53', '#FFA07A'],
    morning: ['#87CEEB', '#98D8E8', '#F0E68C'],
    afternoon: ['#FFD700', '#FFA500', '#FF8C00'],
    dusk: ['#FF6347', '#FF1493', '#8B008B'],
  };
  return gradients[timeOfDay as keyof typeof gradients] || gradients.morning;
};

const WorldTimeTab: React.FC = () => {
  const [cities, setCities] = useState<CityData[]>(defaultCities);
  const [showAddModal, setShowAddModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentTime, setCurrentTime] = useState(dayjs());

  const globalTimeState = useMemo(() => {
    const hours = cities.map(city => dayjs().tz(city.timezone).hour());
    const avgHour = hours.reduce((a, b) => a + b, 0) / hours.length;
    return avgHour >= 6 && avgHour <= 18;
  }, [cities]);

  // Generate stars for night sky (stable random data, computed once on mount)
  const [stars] = useState(() =>
    Array.from({ length: 50 }, (_, i) => ({
      id: i,
      size: Math.random() * 3 + 1,
      top: Math.random() * 100,
      left: Math.random() * 100,
      delay: Math.random() * 3,
    }))
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(dayjs());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleAddCity = useCallback((city: CityData) => {
    setCities(prev => [...prev, { ...city, isFavorite: false }]);
    setShowAddModal(false);
  }, []);

  const handleRemoveCity = useCallback((cityId: string) => {
    setCities(prev => prev.filter(c => c.id !== cityId));
  }, []);

  const handleToggleFavorite = useCallback((cityId: string) => {
    setCities(prev => prev.map(c => (c.id === cityId ? { ...c, isFavorite: !c.isFavorite } : c)));
  }, []);

  const filteredCities = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return allCities.filter(city => !cities.some(c => c.id === city.id));
    }

    const maybeZones = tzAbbreviationToZones[query.toUpperCase()] || [];

    return allCities.filter(city => {
      if (cities.some(c => c.id === city.id)) return false;

      const matchesName = city.name.toLowerCase().includes(query);
      const matchesCountry = city.country.toLowerCase().includes(query);
      const matchesCountryCode = (city.countryCode || '').toLowerCase() === query;
      const matchesTimezone = city.timezone.toLowerCase().includes(query);
      const matchesAbbr = maybeZones.some(z => city.timezone === z);

      return matchesName || matchesCountry || matchesCountryCode || matchesTimezone || matchesAbbr;
    });
  }, [searchQuery, cities]);

  const sortedCities = useMemo(() => {
    return [...cities].sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return 0;
    });
  }, [cities]);

  return (
    <Box sx={{ position: 'relative', minHeight: '100vh', p: 3, overflow: 'hidden' }}>
      {/* Dynamic background */}
      <BackgroundGradient isDaytime={globalTimeState} />

      {/* Stars for night time */}
      {!globalTimeState && (
        <StarsContainer>
          {stars.map(star => (
            <Star key={`star-${star.id}`} size={star.size} top={star.top} left={star.left} delay={star.delay} />
          ))}
        </StarsContainer>
      )}

      {/* Content wrapper with z-index */}
      <Box sx={{ position: 'relative', zIndex: 1 }}>
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            spacing={2}
            mb={4}
          >
            <Stack direction="row" alignItems="center" spacing={{ xs: 1, sm: 2 }}>
              <GlobeIcon sx={{ fontSize: { xs: 32, sm: 40 }, color: globalTimeState ? '#FFD700' : '#E6E6FA' }} />
              <Typography
                level="h1"
                sx={{
                  fontSize: { xs: '1.5rem', sm: '2rem', md: '3rem' },
                  fontWeight: 800,
                  background: globalTimeState
                    ? 'linear-gradient(135deg, #FFD700 0%, #FFA500 100%)'
                    : 'linear-gradient(135deg, #E6E6FA 0%, #9370DB 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  textShadow: '0 0 30px rgba(255,215,0,0.5)',
                }}
              >
                World Time Dashboard
              </Typography>
              <ContextHelpButton helpId="admin/world-time" tooltipText="World Time Help" />
            </Stack>

            <Button
              startDecorator={<AddIcon />}
              onClick={() => setShowAddModal(true)}
              size="lg"
              sx={{
                width: { xs: '100%', sm: 'auto' },
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                '&:hover': {
                  background: 'linear-gradient(135deg, #764ba2 0%, #667eea 100%)',
                },
              }}
            >
              Add Location
            </Button>
          </Stack>
        </motion.div>

        {/* City Grid */}
        <Grid container spacing={3}>
          <AnimatePresence>
            {sortedCities.map((city, index) => {
              const cityTime = currentTime.tz(city.timezone);
              const hour = cityTime.hour();
              const sunPosition = getSunPosition(cityTime, city.lat, city.lng);
              const timeOfDay = getTimeOfDay(hour);
              const isDaytime = sunPosition > 0;
              const gradientColors = getGradientColors(timeOfDay);

              return (
                <Grid key={city.id} xs={12} sm={6} lg={4}>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8, y: -20 }}
                    transition={{
                      duration: 0.5,
                      delay: index * 0.1,
                      type: 'spring',
                      stiffness: 100,
                    }}
                    layout
                  >
                    <GlowingCard glowColor={isDaytime ? '#FFD700' : '#9370DB'} isDaytime={isDaytime}>
                      <Card
                        sx={{
                          background: 'transparent',
                          backdropFilter: 'none',
                          position: 'relative',
                          overflow: 'visible',
                          minHeight: 280,
                          p: 3,
                        }}
                      >
                        {/* City actions */}
                        <Stack direction="row" justifyContent="space-between" sx={{ mb: 2 }}>
                          <IconButton
                            size="sm"
                            onClick={() => handleToggleFavorite(city.id)}
                            sx={{ color: city.isFavorite ? '#FFD700' : 'neutral.400' }}
                          >
                            {city.isFavorite ? <StarIcon /> : <StarBorderIcon />}
                          </IconButton>
                          <IconButton size="sm" onClick={() => handleRemoveCity(city.id)} sx={{ color: 'neutral.400' }}>
                            <CloseIcon />
                          </IconButton>
                        </Stack>

                        {/* Sun/Moon visualization */}
                        <SunMoonContainer
                          animate={{
                            rotate: isDaytime ? 0 : 180,
                            scale: isDaytime ? 1 : 0.8,
                          }}
                          transition={{ duration: 2, type: 'spring' }}
                        >
                          {isDaytime ? (
                            <SunIcon
                              sx={{
                                fontSize: 60,
                                color: '#FFD700',
                                filter: 'drop-shadow(0 0 20px #FFD700)',
                              }}
                            />
                          ) : (
                            <MoonIcon
                              sx={{
                                fontSize: 60,
                                color: '#E6E6FA',
                                filter: 'drop-shadow(0 0 20px #E6E6FA)',
                              }}
                            />
                          )}
                        </SunMoonContainer>

                        {/* City info */}
                        <Stack spacing={1}>
                          <Typography
                            level="h2"
                            sx={{
                              fontSize: '2.5rem',
                              fontWeight: 800,
                              color: isDaytime ? 'neutral.900' : 'neutral.100',
                              textShadow: isDaytime
                                ? '2px 2px 4px rgba(0,0,0,0.1)'
                                : '2px 2px 4px rgba(255,255,255,0.1)',
                            }}
                          >
                            {city.emoji} {city.name}
                          </Typography>

                          <Typography
                            level="body-md"
                            sx={{
                              color: isDaytime ? 'neutral.700' : 'neutral.300',
                              fontWeight: 500,
                            }}
                          >
                            {city.country}
                          </Typography>

                          <Stack spacing={1} sx={{ mt: 2 }}>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <ClockIcon sx={{ fontSize: 20, color: isDaytime ? 'neutral.600' : 'neutral.400' }} />
                              <Typography
                                level="h3"
                                sx={{
                                  fontSize: '1.75rem',
                                  fontWeight: 600,
                                  color: isDaytime ? 'neutral.800' : 'neutral.200',
                                  fontVariantNumeric: 'tabular-nums',
                                }}
                              >
                                {cityTime.format('h:mm:ss A')}
                              </Typography>
                            </Stack>

                            <Stack direction="row" spacing={1} alignItems="center">
                              <CalendarIcon sx={{ fontSize: 20, color: isDaytime ? 'neutral.600' : 'neutral.400' }} />
                              <Typography level="body-lg" sx={{ color: isDaytime ? 'neutral.700' : 'neutral.300' }}>
                                {cityTime.format('dddd, MMMM D, YYYY')}
                              </Typography>
                            </Stack>

                            <Chip
                              size="sm"
                              sx={{
                                mt: 1,
                                background: `linear-gradient(135deg, ${gradientColors[0]} 0%, ${gradientColors[1]} 100%)`,
                                color: 'white',
                                fontWeight: 600,
                              }}
                            >
                              {timeOfDay.charAt(0).toUpperCase() + timeOfDay.slice(1)}
                            </Chip>
                          </Stack>
                        </Stack>

                        {/* Time zone indicator */}
                        <Typography
                          level="body-xs"
                          sx={{
                            position: 'absolute',
                            bottom: 16,
                            right: 16,
                            color: isDaytime ? 'neutral.500' : 'neutral.400',
                            fontFamily: 'monospace',
                          }}
                        >
                          {city.timezone} • UTC{cityTime.format('Z')}
                        </Typography>
                      </Card>
                    </GlowingCard>
                  </motion.div>
                </Grid>
              );
            })}
          </AnimatePresence>
        </Grid>

        {/* Add Location Modal */}
        <Modal open={showAddModal} onClose={() => setShowAddModal(false)}>
          <ModalDialog
            size="lg"
            sx={{
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
            }}
          >
            <ModalClose sx={{ color: 'white' }} />
            <Typography level="h2" sx={{ mb: 2, color: 'white' }}>
              Add New Location
            </Typography>

            <Input
              placeholder='Search cities (try "Los Angeles", "London")...'
              value={searchQuery}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
              startDecorator={<SearchIcon />}
              endDecorator={
                searchQuery ? (
                  <IconButton size="sm" variant="soft" color="neutral" onClick={() => setSearchQuery('')}>
                    <CloseIcon />
                  </IconButton>
                ) : null
              }
              sx={{
                mb: 3,
                background: 'rgba(255,255,255,0.2)',
                color: 'white',
                '&::placeholder': { color: 'rgba(255,255,255,0.7)' },
                '& .MuiInput-startDecorator': { color: 'white' },
              }}
            />

            {/* Quick picks */}
            <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap' }}>
              {['Los Angeles', 'Austin', 'Kyiv', 'Cebu', 'London', 'Tokyo', 'Sydney', 'Dubai'].map(label => (
                <Chip
                  key={label}
                  size="sm"
                  variant="soft"
                  onClick={() => setSearchQuery(label)}
                  sx={{ cursor: 'pointer' }}
                >
                  {label}
                </Chip>
              ))}
              {searchQuery && (
                <Button size="sm" variant="plain" color="neutral" onClick={() => setSearchQuery('')}>
                  Clear search
                </Button>
              )}
            </Stack>

            {filteredCities.length === 0 ? (
              <Sheet
                sx={{
                  p: 3,
                  borderRadius: 'md',
                  background: 'rgba(255,255,255,0.08)',
                  textAlign: 'center',
                }}
              >
                <Typography level="body-lg" sx={{ color: 'white', mb: 1 }}>
                  No results for &quot;{searchQuery}&quot;.
                </Typography>
                <Button size="sm" variant="soft" onClick={() => setSearchQuery('')}>
                  Clear search
                </Button>
              </Sheet>
            ) : (
              <Stack spacing={2} sx={{ maxHeight: 400, overflowY: 'auto' }}>
                {filteredCities.map(city => (
                  <motion.div key={city.id} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                    <Sheet
                      onClick={() => handleAddCity(city)}
                      sx={{
                        p: 2,
                        borderRadius: 'md',
                        cursor: 'pointer',
                        background: 'rgba(255,255,255,0.1)',
                        transition: 'all 0.3s ease',
                        '&:hover': {
                          background: 'rgba(255,255,255,0.2)',
                        },
                      }}
                    >
                      <Stack direction="row" alignItems="center" spacing={2}>
                        <Typography level="h4" sx={{ color: 'white' }}>
                          {city.emoji}
                        </Typography>
                        <Stack>
                          <Typography level="body-lg" sx={{ color: 'white', fontWeight: 600 }}>
                            {city.name}
                          </Typography>
                          <Typography level="body-sm" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                            {city.country} • {city.timezone}
                          </Typography>
                        </Stack>
                      </Stack>
                    </Sheet>
                  </motion.div>
                ))}
              </Stack>
            )}
          </ModalDialog>
        </Modal>
      </Box>
    </Box>
  );
};

export default WorldTimeTab;
