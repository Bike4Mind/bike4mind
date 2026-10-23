import DateTimeIcon from '@mui/icons-material/Schedule';
import DiceIcon from '@mui/icons-material/Casino';
import ImageIcon from '@mui/icons-material/Image';
import MusicIcon from '@mui/icons-material/MusicNote';
import AudioIcon from '@mui/icons-material/GraphicEq';
import VideoIcon from '@mui/icons-material/Videocam';
import MathIcon from '@mui/icons-material/Calculate';
import MermaidIcon from '@mui/icons-material/Schema';
import SearchIcon from '@mui/icons-material/Search';
import WebFetchIcon from '@mui/icons-material/Language';
import WeatherIcon from '@mui/icons-material/WbSunny';
import RechartsIcon from '@mui/icons-material/BarChart';
import HistoryIcon from '@mui/icons-material/History';
import MoonIcon from '@mui/icons-material/NightsStay';
import SunriseIcon from '@mui/icons-material/WbTwilight';
import SatelliteIcon from '@mui/icons-material/Satellite';
import PlanetIcon from '@mui/icons-material/Explore';

export const TOOLS_MAP = {
  web_search: {
    name: 'Web Search',
    description: 'Search the web for information',
    icon: <SearchIcon />,
  },
  web_fetch: {
    name: 'Web Fetch',
    description: 'Fetch and read full content from a URL',
    icon: <WebFetchIcon />,
  },
  image_generation: {
    name: 'Image Generation',
    description: 'Generate an image',
    icon: <ImageIcon />,
  },
  music_generation: {
    name: 'Music Generation',
    description: 'Generate background music',
    icon: <MusicIcon />,
  },
  audio_generation: {
    name: 'Audio Generation',
    description: 'Generate speech or sound effects',
    icon: <AudioIcon />,
  },
  video_generation: {
    name: 'Video Generation',
    description: 'Generate a short video clip',
    icon: <VideoIcon />,
  },
  mermaid_chart: {
    name: 'Mermaid Chart',
    description: 'Generate a mermaid chart',
    icon: <MermaidIcon />,
  },
  weather_info: {
    name: 'Weather Info',
    description: 'Get the weather',
    icon: <WeatherIcon />,
  },
  math_evaluate: {
    name: 'Math Evaluation',
    description: 'Evaluate a math expression',
    icon: <MathIcon />,
  },
  current_datetime: {
    name: 'Current Date/Time',
    description: 'Get the current date and time',
    icon: <DateTimeIcon />,
  },
  dice_roll: {
    name: 'Dice Roll',
    description: 'Roll a dice',
    icon: <DiceIcon />,
  },
  recharts: {
    name: 'Charts',
    description: 'Generate interactive charts',
    icon: <RechartsIcon />,
  },
  wikipedia_on_this_day: {
    name: 'On This Day',
    description: 'Historical events, births, deaths from Wikipedia',
    icon: <HistoryIcon />,
  },
  moon_phase: {
    name: 'Moon Phase',
    description: 'Current moon phase, illumination, and lunar calendar',
    icon: <MoonIcon />,
  },
  sunrise_sunset: {
    name: 'Sunrise/Sunset',
    description: 'Sun times, twilight, golden hour for any location',
    icon: <SunriseIcon />,
  },
  iss_tracker: {
    name: 'ISS Tracker',
    description: 'Track the International Space Station position and crew',
    icon: <SatelliteIcon />,
  },
  planet_visibility: {
    name: 'Planet Visibility',
    description: 'Which planets are visible tonight and where to look',
    icon: <PlanetIcon />,
  },
} as const;

export const emojis = [
  '😀',
  '😃',
  '😄',
  '😁',
  '😅',
  '😂',
  '🤣',
  '😊',
  '😇',
  '🙂',
  '😉',
  '😌',
  '😍',
  '🥰',
  '😘',
  '🐶',
  '🐱',
  '🐭',
  '🐹',
  '🐰',
  '🦊',
  '🐻',
  '🐼',
  '🐨',
  '🐯',
  '🦁',
  '🐮',
  '🐷',
  '🐸',
  '🌟',
  '⭐',
  '✨',
  '💫',
  '🌙',
  '☀️',
  '⚡️',
  '🌈',
  '🌺',
  '🌸',
  '🌼',
  '🌻',
  '🌹',
  '🍀',
  '❤️',
  '🧡',
  '💛',
  '💚',
  '💙',
  '💜',
  '🖤',
  '🤍',
  '🤎',
  '💔',
  '❣️',
  '💕',
  '💞',
  '💓',
  '🎯',
  '🎲',
  '🎮',
  '🎨',
  '🎭',
  '🎪',
  '🎫',
  '🎟️',
  '🎪',
  '🎭',
  '🎨',
  '🎬',
  '🎤',
] as const;

export const colorPalettes = [
  { name: 'Grey', key: 'grey' },
  { name: 'Blue', key: 'blue' },
  { name: 'Red', key: 'red' },
  { name: 'Green', key: 'green' },
  { name: 'Yellow', key: 'yellow' },
] as const;

export const shades = [100, 200, 300, 400, 500, 600, 700, 800] as const;
