import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Box, Button, Chip, IconButton, Input, Sheet, Stack, Typography } from '@mui/joy';
import SunIcon from '@mui/icons-material/WbSunny';
import MoonIcon from '@mui/icons-material/NightsStay';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import { WORLD_CITIES } from './worldCities';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { AdminDialog, AdminPageHeader, EmptyState, SectionCard } from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

dayjs.extend(timezone);
dayjs.extend(utc);
dayjs.extend(advancedFormat);

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

const QUICK_PICKS = ['Los Angeles', 'Austin', 'Kyiv', 'Cebu', 'London', 'Tokyo', 'Sydney', 'Dubai'];

const WorldTimeTab: React.FC = () => {
  const [cities, setCities] = useState<CityData[]>(defaultCities);
  const [showAddModal, setShowAddModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentTime, setCurrentTime] = useState(dayjs());

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
    <Stack sx={{ gap: ADMIN_REGION_GAP }} data-testid="admin-world-time-tab">
      <AdminPageHeader
        title="World time"
        count={cities.length}
        description="Local time, date and offset for the team's cities. Favorites sort first."
        actions={
          <>
            <ContextHelpButton helpId="admin/world-time" tooltipText="World time help" />
            <Button
              size="sm"
              startDecorator={<AddIcon />}
              onClick={() => setShowAddModal(true)}
              data-testid="admin-world-time-add-btn"
            >
              Add location
            </Button>
          </>
        }
      />

      {sortedCities.length === 0 ? (
        <Sheet variant="outlined" sx={{ bgcolor: 'admin.surface', borderColor: 'admin.border', borderRadius: 'lg' }}>
          <EmptyState
            title="No locations yet"
            description="Add a city to see its local time."
            action={
              <Button size="sm" variant="outlined" onClick={() => setShowAddModal(true)}>
                Add location
              </Button>
            }
          />
        </Sheet>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
          }}
        >
          {sortedCities.map(city => {
            const cityTime = currentTime.tz(city.timezone);
            const isDaytime = getSunPosition(cityTime, city.lat, city.lng) > 0;
            const timeOfDay = getTimeOfDay(cityTime.hour());
            const DayIcon = isDaytime ? SunIcon : MoonIcon;

            return (
              <SectionCard
                key={city.id}
                title={city.name}
                body="custom"
                data-testid={`admin-world-time-city-${city.id}`}
                action={
                  <Stack direction="row" gap={0.5}>
                    <IconButton
                      size="sm"
                      variant="plain"
                      aria-label={city.isFavorite ? `Unfavorite ${city.name}` : `Favorite ${city.name}`}
                      aria-pressed={Boolean(city.isFavorite)}
                      onClick={() => handleToggleFavorite(city.id)}
                      sx={{ color: city.isFavorite ? 'admin.ink' : 'admin.inkMuted' }}
                    >
                      {city.isFavorite ? <StarIcon sx={{ fontSize: 18 }} /> : <StarBorderIcon sx={{ fontSize: 18 }} />}
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="plain"
                      aria-label={`Remove ${city.name}`}
                      onClick={() => handleRemoveCity(city.id)}
                      sx={{ color: 'admin.inkMuted' }}
                    >
                      <CloseIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Stack>
                }
              >
                <Stack gap={1} sx={{ px: 2, py: 1.75 }}>
                  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
                    {city.country}
                  </Typography>
                  <Typography
                    sx={{
                      color: 'admin.ink',
                      fontSize: 22,
                      fontWeight: 600,
                      lineHeight: 1.25,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {cityTime.format('h:mm:ss A')}
                  </Typography>
                  <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
                    {cityTime.format('dddd, MMMM D, YYYY')}
                  </Typography>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1} flexWrap="wrap">
                    <Chip
                      size="sm"
                      variant="soft"
                      color="neutral"
                      startDecorator={<DayIcon sx={{ fontSize: 16, color: 'admin.inkMuted' }} />}
                    >
                      {timeOfDay.charAt(0).toUpperCase() + timeOfDay.slice(1)}
                    </Chip>
                    <Typography
                      level="body-xs"
                      sx={{ color: 'admin.inkMuted', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}
                    >
                      {city.timezone} - UTC{cityTime.format('Z')}
                    </Typography>
                  </Stack>
                </Stack>
              </SectionCard>
            );
          })}
        </Box>
      )}

      <AdminDialog
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add location"
        width={520}
        data-testid="admin-world-time-add-dialog"
      >
        <Stack gap={2}>
          <Input
            size="sm"
            placeholder='Search cities (try "Los Angeles", "London")'
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            startDecorator={<SearchIcon sx={{ fontSize: 16, color: 'admin.inkMuted' }} />}
            endDecorator={
              searchQuery ? (
                <IconButton size="sm" variant="plain" aria-label="Clear search" onClick={() => setSearchQuery('')}>
                  <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
              ) : null
            }
            slotProps={{ input: { 'aria-label': 'Search cities' } }}
          />

          <Stack direction="row" gap={1} flexWrap="wrap">
            {QUICK_PICKS.map(label => (
              <Chip key={label} size="sm" variant="outlined" color="neutral" onClick={() => setSearchQuery(label)}>
                {label}
              </Chip>
            ))}
          </Stack>

          {filteredCities.length === 0 ? (
            <EmptyState
              title={`No results for "${searchQuery}"`}
              action={
                <Button size="sm" variant="outlined" onClick={() => setSearchQuery('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <Stack
              component="ul"
              sx={{
                m: 0,
                p: 0,
                listStyle: 'none',
                maxHeight: 400,
                overflowY: 'auto',
                border: '1px solid',
                borderColor: 'admin.border',
                borderRadius: 'md',
                '& > li + li': { borderTop: '1px solid', borderColor: 'admin.border' },
              }}
            >
              {filteredCities.map(city => (
                <Box component="li" key={city.id}>
                  <Box
                    component="button"
                    type="button"
                    onClick={() => handleAddCity(city)}
                    sx={{
                      all: 'unset',
                      boxSizing: 'border-box',
                      display: 'block',
                      width: '100%',
                      px: 1.5,
                      py: 1,
                      cursor: 'pointer',
                      '&:hover': { bgcolor: 'admin.hover' },
                      '&:focus-visible': { outline: '2px solid', outlineColor: 'admin.accent', outlineOffset: -2 },
                    }}
                  >
                    <Typography level="body-sm" sx={{ color: 'admin.ink', fontWeight: 500 }}>
                      {city.name}
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                      {city.country} - {city.timezone}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          )}
        </Stack>
      </AdminDialog>
    </Stack>
  );
};

export default WorldTimeTab;
