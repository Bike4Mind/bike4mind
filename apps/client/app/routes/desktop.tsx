import { type ReactNode, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, IconButton, Link, Stack, Tooltip, Typography } from '@mui/joy';
import { keyframes, useMediaQuery } from '@mui/system';
import { Link as RouterLink } from '@tanstack/react-router';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { useLatestDesktopRelease } from '@client/app/hooks/data/desktopRelease';
import { detectPlatform, detectPlatformFromUserAgent, type DetectedPlatform } from '@client/app/utils/desktopPlatform';
import {
  DESKTOP_ALL_RELEASES_URL,
  DESKTOP_INSTALL_COMMAND,
  DESKTOP_RELEASES_PAGE_URL,
  type DesktopRelease,
} from '@client/app/utils/desktopReleases';

type PlatformId = 'mac-arm64' | 'mac-intel' | 'linux-x64' | 'linux-arm64' | 'windows';
type AvailablePlatformId = 'mac-arm64' | 'linux-x64';

const PLATFORM_LABELS: Record<PlatformId, string> = {
  'mac-arm64': 'macOS (Apple Silicon)',
  'mac-intel': 'macOS (Intel)',
  'linux-x64': 'Linux (x64)',
  'linux-arm64': 'Linux (ARM)',
  windows: 'Windows',
};

const UNAVAILABLE_REASONS: Partial<Record<PlatformId, { status: string; detail: string }>> = {
  'mac-intel': { status: 'Paused', detail: 'Builds for Intel Macs are temporarily paused.' },
  'linux-arm64': { status: 'Not available yet', detail: 'There is no build for ARM Linux yet.' },
  windows: { status: 'Not available yet', detail: 'There is no Windows build yet.' },
};

const SUPPORTED_SUMMARY = 'The desktop app runs on macOS (Apple Silicon) and Linux (x64).';

const LISTED_PLATFORMS: PlatformId[] = ['mac-arm64', 'mac-intel', 'linux-x64', 'windows'];

// install.sh's default destinations; the terminal preview prints its real messages
// (apps/desktop/install.sh), so keep these in step with it.
const INSTALL_DESTINATIONS: Record<AvailablePlatformId, string> = {
  'mac-arm64': '/Applications/Bike4Mind.app',
  'linux-x64': '~/.local/share/bike4mind/Bike4Mind.AppImage',
};

// Summarised from apps/desktop/README.md; keep in step with what the desktop app actually does.
const DESKTOP_FACTS = [
  {
    icon: FolderOpenOutlinedIcon,
    title: 'Code mode on your projects',
    body: 'Open a conversation on a project folder and work on its current branch.',
  },
  {
    icon: VerifiedUserOutlinedIcon,
    title: 'Local tools, with your approval',
    body: 'File and shell tools run on your computer, and each one asks before it acts.',
  },
  {
    icon: PersonOutlineRoundedIcon,
    title: 'Your Bike4Mind account',
    body: 'Sign in with the account you use here.',
  },
];

// A terminal is dark whatever the page theme, so these stay fixed in light and dark mode.
const TERMINAL = {
  window: '#0F1A2E',
  titleBar: '#16233B',
  border: 'rgba(148, 163, 184, 0.18)',
  text: '#E2E8F0',
  muted: '#94A3B8',
  prompt: '#60A5FA',
  success: '#4ADE80',
};

const TYPE_INTERVAL_MS = 24;
const CHARS_PER_TICK = 2;

const blink = keyframes`
  50% { opacity: 0; }
`;

const settleIn = keyframes`
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
`;

const cursorSx = {
  display: 'inline-block',
  width: '0.6em',
  height: '1.1em',
  verticalAlign: 'text-bottom',
  bgcolor: TERMINAL.prompt,
};

/** Which platform to lead with. A Mac of unknown chip leads with Apple Silicon, the only Mac build. */
function primaryPlatform({ os, arch }: DetectedPlatform): PlatformId | null {
  if (os === 'mac') return arch === 'x64' ? 'mac-intel' : 'mac-arm64';
  if (os === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (os === 'windows') return 'windows';
  return null;
}

const isAvailable = (platform: PlatformId | null): platform is AvailablePlatformId =>
  platform === 'mac-arm64' || platform === 'linux-x64';

function useDetectedPlatform(): DetectedPlatform {
  const [platform, setPlatform] = useState(() =>
    detectPlatformFromUserAgent(navigator.userAgent, navigator.maxTouchPoints)
  );
  useEffect(() => {
    let cancelled = false;
    void detectPlatform(navigator).then(detected => {
      if (!cancelled) setPlatform(detected);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return platform;
}

/** How many characters of `text` to show: types it out once, or shows it whole under reduced motion. */
function useTypedLength(text: string): number {
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (reduceMotion) return;
    const timer = setInterval(() => {
      setTyped(current => {
        const next = Math.min(current + CHARS_PER_TICK, text.length);
        if (next === text.length) clearInterval(timer);
        return next;
      });
    }, TYPE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reduceMotion, text]);
  return reduceMotion ? text.length : typed;
}

function downloadFor(platform: AvailablePlatformId, release: DesktopRelease | undefined) {
  const url = platform === 'mac-arm64' ? release?.macArm64DmgUrl : release?.linuxX64AppImageUrl;
  const fileLabel = platform === 'mac-arm64' ? '.dmg' : '.AppImage';
  return url
    ? { href: url, label: `Download ${fileLabel}`, external: false }
    : {
        href: release?.releaseUrl ?? DESKTOP_RELEASES_PAGE_URL,
        label: `Get the ${fileLabel} on GitHub`,
        external: true,
      };
}

const externalLinkProps = (external: boolean) => (external ? { target: '_blank', rel: 'noopener noreferrer' } : {});

function TerminalWindow({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        borderRadius: '12px',
        overflow: 'hidden',
        bgcolor: TERMINAL.window,
        color: TERMINAL.text,
        border: `1px solid ${TERMINAL.border}`,
        boxShadow: '0 1px 2px rgba(15, 26, 46, 0.2), 0 24px 48px -12px rgba(15, 26, 46, 0.45)',
      }}
    >
      <Box
        aria-hidden
        sx={{ display: 'flex', alignItems: 'center', gap: '8px', px: 2, height: 38, bgcolor: TERMINAL.titleBar }}
      >
        {['#FF5F57', '#FEBC2E', '#28C840'].map(color => (
          <Box key={color} sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: color }} />
        ))}
        <Typography level="body-xs" sx={{ flex: 1, textAlign: 'center', color: TERMINAL.muted, mr: '44px' }}>
          Terminal
        </Typography>
      </Box>
      <Box sx={{ px: { xs: 2, sm: 2.5 }, pt: 2, pb: 2.5, fontFamily: 'code', fontSize: '14px', lineHeight: 1.7 }}>
        {children}
      </Box>
    </Box>
  );
}

function InstallTerminal({
  platform,
  release,
}: {
  platform: AvailablePlatformId;
  release: DesktopRelease | undefined;
}) {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();
  const typed = useTypedLength(DESKTOP_INSTALL_COMMAND);
  const done = typed === DESKTOP_INSTALL_COMMAND.length;
  const version = release ? ` ${release.version}` : '';

  return (
    <TerminalWindow>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
        <Box component="span" aria-hidden sx={{ color: TERMINAL.prompt, userSelect: 'none' }}>
          $
        </Box>
        {/* The untyped rest stays in the layout, hidden, so the window never resizes while it types. */}
        <Box
          data-testid="desktop-download-command"
          component="code"
          sx={{ flex: 1, minWidth: 0, fontFamily: 'inherit', overflowWrap: 'anywhere' }}
        >
          <span>{DESKTOP_INSTALL_COMMAND.slice(0, typed)}</span>
          {!done && <Box component="span" aria-hidden sx={cursorSx} />}
          <span style={{ visibility: 'hidden' }}>{DESKTOP_INSTALL_COMMAND.slice(typed)}</span>
        </Box>
        <Tooltip title={copied ? 'Copied' : 'Copy command'} variant="soft" size="sm">
          <IconButton
            data-testid="desktop-download-copy-btn"
            size="sm"
            variant="soft"
            aria-label="Copy install command"
            onClick={() => handleCopyToClipboard(DESKTOP_INSTALL_COMMAND)}
            sx={{
              mt: '-2px',
              '--Icon-color': TERMINAL.text,
              bgcolor: 'rgba(148, 163, 184, 0.16)',
              '&:hover': { bgcolor: 'rgba(148, 163, 184, 0.28)' },
            }}
          >
            {copied ? <CheckRoundedIcon /> : <ContentCopyRoundedIcon />}
          </IconButton>
        </Tooltip>
      </Box>
      {done && (
        <Box aria-hidden sx={{ mt: 1, animation: `${settleIn} 240ms ease-out both` }}>
          <Box sx={{ color: TERMINAL.muted }}>Downloading Bike4Mind{version}...</Box>
          <Box sx={{ color: TERMINAL.success, overflowWrap: 'anywhere' }}>
            Installed Bike4Mind{version} to {INSTALL_DESTINATIONS[platform]}
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 0.5 }}>
            <span style={{ color: TERMINAL.prompt }}>$</span>
            <Box
              component="span"
              sx={{
                ...cursorSx,
                animation: `${blink} 1.1s steps(1) infinite`,
                '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
              }}
            />
          </Box>
        </Box>
      )}
    </TerminalWindow>
  );
}

function UnavailableTerminal({ platform }: { platform: PlatformId | null }) {
  const reason = platform ? UNAVAILABLE_REASONS[platform]?.detail : undefined;
  return (
    <TerminalWindow>
      <Box data-testid="desktop-download-unavailable" sx={{ color: TERMINAL.muted }}>
        {reason && <Box># {reason}</Box>}
        <Box># {SUPPORTED_SUMMARY}</Box>
        {!reason && <Box># Open this page on one of those computers to install it.</Box>}
      </Box>
    </TerminalWindow>
  );
}

function GatekeeperNote() {
  return (
    <Alert
      data-testid="desktop-download-gatekeeper-note"
      variant="soft"
      color="neutral"
      size="sm"
      startDecorator={<InfoOutlinedIcon />}
      sx={{ alignItems: 'flex-start' }}
    >
      <Box>
        <Typography level="title-sm">The macOS app is a beta and is not notarized yet</Typography>
        <Typography level="body-sm">
          The install command sets it up without a security prompt. If you open the .dmg from your browser instead,
          macOS blocks it the first time: go to System Settings &gt; Privacy &amp; Security and click Open Anyway.
        </Typography>
      </Box>
    </Alert>
  );
}

function HeroDetails({
  primary,
  detected,
  release,
}: {
  primary: PlatformId | null;
  detected: DetectedPlatform;
  release: DesktopRelease | undefined;
}) {
  // The terminal beside this explains what is missing, so only the platform is named here.
  if (!isAvailable(primary)) {
    return primary ? (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography level="title-md">{PLATFORM_LABELS[primary]}</Typography>
        <Chip size="sm" variant="soft" color="neutral">
          {UNAVAILABLE_REASONS[primary]?.status}
        </Chip>
      </Stack>
    ) : null;
  }

  const macChipUnknown = detected.os === 'mac' && detected.arch === 'unknown';
  const download = downloadFor(primary, release);
  const isMac = primary === 'mac-arm64';
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography level="title-md">{macChipUnknown ? 'macOS' : PLATFORM_LABELS[primary]}</Typography>
        {isMac && (
          <Chip size="sm" variant="soft" color="warning">
            Beta
          </Chip>
        )}
      </Stack>
      <Typography level="body-md">
        Paste the command into {isMac ? 'Terminal' : 'a terminal'}. Run it again any time to update.
      </Typography>
      {macChipUnknown && (
        <Typography data-testid="desktop-download-ambiguous-note" level="body-sm">
          The Mac app runs on Apple Silicon (M1 or later). Not sure which chip you have? Open the Apple menu &gt; About
          This Mac: an Apple Silicon Mac lists a Chip starting with &quot;Apple M&quot;. Builds for Intel Macs are
          temporarily paused.
        </Typography>
      )}
      <Box>
        <Button
          data-testid={isMac ? 'desktop-download-dmg-link' : 'desktop-download-appimage-link'}
          component="a"
          href={download.href}
          {...externalLinkProps(download.external)}
          variant="outlined"
          color="neutral"
          startDecorator={<DownloadRoundedIcon />}
          endDecorator={download.external ? <OpenInNewRoundedIcon /> : undefined}
        >
          {download.label}
        </Button>
      </Box>
    </Stack>
  );
}

function OtherPlatformRow({ platform, release }: { platform: PlatformId; release: DesktopRelease | undefined }) {
  const unavailable = UNAVAILABLE_REASONS[platform];
  const download = isAvailable(platform) ? downloadFor(platform, release) : null;
  return (
    <Box
      data-testid={`desktop-download-platform-${platform}`}
      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, py: 1.5 }}
    >
      <Typography level="body-md">{PLATFORM_LABELS[platform]}</Typography>
      {unavailable ? (
        <Chip size="sm" variant="soft" color="neutral">
          {unavailable.status}
        </Chip>
      ) : (
        download && (
          <Link href={download.href} level="body-sm" {...externalLinkProps(download.external)}>
            {download.label}
          </Link>
        )
      )}
    </Box>
  );
}

export default function DesktopDownloadPage() {
  const detected = useDetectedPlatform();
  const { data: release } = useLatestDesktopRelease();
  const primary = primaryPlatform(detected);
  const others = LISTED_PLATFORMS.filter(platform => platform !== primary);

  return (
    <Box
      data-testid="desktop-download-page"
      sx={{ minHeight: '100dvh', bgcolor: 'background.body', px: 2, pt: { xs: 3, sm: 4 }, pb: { xs: 6, sm: 10 } }}
    >
      <Box sx={{ maxWidth: 1120, mx: 'auto' }}>
        <Link
          data-testid="desktop-download-back-link"
          component={RouterLink}
          to="/"
          level="body-sm"
          color="neutral"
          startDecorator={<ArrowBackRoundedIcon />}
        >
          Back to the app
        </Link>

        <Box
          data-testid="desktop-download-primary"
          data-platform={primary ?? 'none'}
          component="section"
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 5fr) minmax(0, 6fr)' },
            gap: { xs: 4, md: 7 },
            alignItems: 'start',
            mt: { xs: 4, md: 8 },
          }}
        >
          <Stack spacing={3}>
            <Typography
              level="h1"
              sx={{
                fontSize: 'clamp(2.5rem, 5.5vw, 4rem)',
                fontWeight: 800,
                lineHeight: 1.02,
                letterSpacing: '-0.035em',
                textWrap: 'balance',
              }}
            >
              Bike4Mind, on your desktop
            </Typography>
            <Typography level="body-lg" sx={{ maxWidth: '34ch', color: 'text.secondary' }}>
              A native app that works with the files and tools on your own computer.
            </Typography>
            <HeroDetails primary={primary} detected={detected} release={release} />
          </Stack>
          <Box sx={{ pt: { md: 1 } }}>
            {isAvailable(primary) ? (
              <Stack spacing={2.5}>
                <InstallTerminal platform={primary} release={release} />
                {primary === 'mac-arm64' && <GatekeeperNote />}
              </Stack>
            ) : (
              <UnavailableTerminal platform={primary} />
            )}
          </Box>
        </Box>

        <Box
          component="ul"
          sx={{
            listStyle: 'none',
            p: 0,
            m: 0,
            mt: { xs: 7, md: 10 },
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
            gap: { xs: 3, sm: 4 },
          }}
        >
          {DESKTOP_FACTS.map(({ icon: Icon, title, body }) => (
            <Box component="li" key={title}>
              <Icon sx={{ fontSize: 24, color: 'primary.plainColor', mb: 1 }} />
              <Typography level="title-md">{title}</Typography>
              <Typography level="body-sm" sx={{ mt: 0.5, maxWidth: '36ch' }}>
                {body}
              </Typography>
            </Box>
          ))}
        </Box>

        <Box
          data-testid="desktop-download-other-platforms"
          sx={{ mt: { xs: 7, md: 9 }, pt: 3, borderTop: '1px solid', borderColor: 'divider', maxWidth: 640 }}
        >
          <Typography level="title-sm" sx={{ mb: 0.5 }}>
            {primary ? 'Other platforms' : 'Platforms'}
          </Typography>
          <Stack sx={{ '& > * + *': { borderTop: '1px solid', borderColor: 'divider' } }}>
            {others.map(platform => (
              <OtherPlatformRow key={platform} platform={platform} release={release} />
            ))}
          </Stack>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 3 }}>
            <Typography data-testid="desktop-download-version" level="body-sm">
              {release ? `Version ${release.version}` : 'Latest version'}
            </Typography>
            <Link
              data-testid="desktop-download-release-notes-link"
              href={release?.releaseUrl ?? DESKTOP_RELEASES_PAGE_URL}
              level="body-sm"
              {...externalLinkProps(true)}
            >
              Release notes and checksums
            </Link>
            <Link
              data-testid="desktop-download-all-releases-link"
              href={DESKTOP_ALL_RELEASES_URL}
              level="body-sm"
              {...externalLinkProps(true)}
            >
              All releases
            </Link>
          </Stack>
        </Box>
      </Box>
    </Box>
  );
}
