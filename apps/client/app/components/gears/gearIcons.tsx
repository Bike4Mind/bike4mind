import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import FolderSharedIcon from '@mui/icons-material/FolderSharedOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MicOutlinedIcon from '@mui/icons-material/MicOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import GroupAddOutlinedIcon from '@mui/icons-material/GroupAddOutlined';
import ForkRightOutlinedIcon from '@mui/icons-material/ForkRightOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import MusicNoteOutlinedIcon from '@mui/icons-material/MusicNoteOutlined';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
import CableOutlinedIcon from '@mui/icons-material/CableOutlined';
import SecurityOutlinedIcon from '@mui/icons-material/SecurityOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import TravelExploreOutlinedIcon from '@mui/icons-material/TravelExploreOutlined';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import IosShareOutlinedIcon from '@mui/icons-material/IosShareOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import FunctionsOutlinedIcon from '@mui/icons-material/FunctionsOutlined';
import CalculateOutlinedIcon from '@mui/icons-material/CalculateOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import LocalFireDepartmentOutlinedIcon from '@mui/icons-material/LocalFireDepartmentOutlined';
import { DataLakeIcon } from '@client/app/components/datalake/dataLakeBranding';
import { Box } from '@mui/joy';
import { cloneElement } from 'react';
import type { GearKey } from '@client/app/hooks/useGearsStatus';

const GEAR_ICONS: Partial<Record<GearKey, React.ReactElement>> = {
  projects: <HubOutlinedIcon />,
  agents: <SmartToyOutlinedIcon />,
  datalakes: <DataLakeIcon />,
  files: <FolderSharedIcon />,
  published: <PublicOutlinedIcon />,
  hearth: <LocalFireDepartmentOutlinedIcon />,
  image: <ImageOutlinedIcon />,
  models: <SwapHorizOutlinedIcon />,
  react: <CodeOutlinedIcon />,
  python: <DataObjectOutlinedIcon />,
  voice: <MicOutlinedIcon />,
  shareproject: <GroupAddOutlinedIcon />,
  apikey: <KeyOutlinedIcon />,
  apicall: <TerminalOutlinedIcon />,
  forknotebook: <ForkRightOutlinedIcon />,
  downloadnotebook: <DownloadOutlinedIcon />,
  questmaster: <AutoAwesomeOutlinedIcon />,
  mementos: <PsychologyOutlinedIcon />,
  video: <MovieOutlinedIcon />,
  music: <MusicNoteOutlinedIcon />,
  sound: <GraphicEqOutlinedIcon />,
  mcp: <CableOutlinedIcon />,
  mfa: <SecurityOutlinedIcon />,
  slack: <ForumOutlinedIcon />,
  importopenai: <CloudDownloadOutlinedIcon />,
  importclaude: <CloudDownloadOutlinedIcon />,
  research: <TravelExploreOutlinedIcon />,
  rapidreply: <BoltOutlinedIcon />,
  shareagent: <IosShareOutlinedIcon />,
  websearch: <SearchOutlinedIcon />,
  webfetch: <LanguageOutlinedIcon />,
  wolfram: <FunctionsOutlinedIcon />,
  matheval: <CalculateOutlinedIcon />,
  clidocs: <MenuBookOutlinedIcon />,
};

/**
 * Each glyph's own bounds inside MUI's 24x24 box, measured with getBBox and
 * squared off, used as the icon's viewBox.
 *
 * Material's keylines differ by shape on purpose - a circle spans 20 units, a
 * square 18, a bar 16 - so at one font-size the drawings range from 16 to 24 and
 * a column of them reads as a jumble. Cropping the box to the glyph makes every
 * drawing fill the same 20px, where scaling the svg would have grown the element
 * past it. Only the glyphs that miss the common '2 2 20' keyline are listed.
 */
/** The slot every icon occupies, and the glyph drawn inside it. A fixed slot
 *  keeps the titles aligned across cards whatever the glyph does. */
const ICON_SLOT = 20;
const ICON_BOX = 16;
const GLYPH_VIEWBOX: Partial<Record<GearKey, string>> = {
  projects: '0 -0.5 24 24',
  agents: '1 0.5 22 22',
  datalakes: '2 2.5 20 20',
  hearth: '2.5 2 19 19',
  image: '3 3 18 18',
  models: '3 3 18 18',
  voice: '2.5 2 19 19',
  shareproject: '0 0 24 24',
  apikey: '1 1 22 22',
  forknotebook: '4 3 18 18',
  downloadnotebook: '3.5 3 17 17',
  questmaster: '1 1 22 22',
  mementos: '3 3 18 18',
  music: '3 3 18 18',
  mcp: '3 3 18 18',
  mfa: '1 1 22 22',
  importopenai: '0 0 24 24',
  importclaude: '0 0 24 24',
  research: '2 1.75 20.5 20.5',
  rapidreply: '3 3 18 18',
  shareagent: '1 1 22 22',
  websearch: '3 3 17.49 17.49',
  wolfram: '4 4 16 16',
  matheval: '3 3 18 18',
  clidocs: '1 2 22 22',
};

export const GearIcon = ({ gearKey }: { gearKey: GearKey }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: `${ICON_SLOT}px`,
      height: `${ICON_SLOT}px`,
      flexShrink: 0,
      // Tertiary because an icon at title strength competes with the
      // title beside it, thirty times over.
      color: 'text.tertiary',
      '& > svg': { fontSize: `${ICON_BOX}px` },
    }}
  >
    {cloneElement(GEAR_ICONS[gearKey] ?? <SettingsOutlinedIcon />, {
      viewBox: GLYPH_VIEWBOX[gearKey] ?? '2 2 20 20',
    })}
  </Box>
);
