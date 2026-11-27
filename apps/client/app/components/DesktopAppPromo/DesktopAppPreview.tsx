import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/joy';
import { keyframes } from '@mui/system';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded';
import ChatBubbleOutlineRoundedIcon from '@mui/icons-material/ChatBubbleOutlineRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CodeRoundedIcon from '@mui/icons-material/CodeRounded';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import TerminalRoundedIcon from '@mui/icons-material/TerminalRounded';

// A drawing of the desktop app's Code mode rather than a screenshot: it follows the page theme and
// carries no real user data. Its layout and labels mirror apps/desktop (ModeSwitcher, SessionList,
// ApprovalChoice, Composer), so keep it roughly in step when those change.

const SESSIONS = [
  { project: 'web-app', titles: ['Fix the flaky upload test', 'Add dark mode to settings', 'Tidy the API client'] },
  { project: 'docs', titles: ['Write the install guide'] },
];
const OPEN_SESSION = 'Fix the flaky upload test';

const settleIn = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
`;

/** Steps the thread in once on load, as if the session were being worked live. */
const enter = (step: number) => ({
  animation: `${settleIn} 360ms ease-out both`,
  animationDelay: `${250 + step * 320}ms`,
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
});

const tiny = { fontSize: '11px', lineHeight: 1.45 };
const small = { fontSize: '12.5px', lineHeight: 1.5 };

function Sidebar() {
  return (
    <Box
      sx={{
        display: { xs: 'none', sm: 'flex' },
        flexDirection: 'column',
        gap: 1.25,
        width: 196,
        flexShrink: 0,
        p: 1.25,
        bgcolor: 'background.level1',
        borderRight: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Box sx={{ display: 'flex', p: '3px', borderRadius: '8px', bgcolor: 'background.level2' }}>
        {[
          { label: 'Chat', icon: ChatBubbleOutlineRoundedIcon, active: false },
          { label: 'Code', icon: CodeRoundedIcon, active: true },
        ].map(({ label, icon: Icon, active }) => (
          <Box
            key={label}
            sx={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.5,
              py: '3px',
              borderRadius: '6px',
              ...tiny,
              fontWeight: active ? 600 : 400,
              color: active ? 'text.primary' : 'text.tertiary',
              bgcolor: active ? 'background.surface' : 'transparent',
              boxShadow: active ? 'xs' : 'none',
            }}
          >
            <Icon sx={{ fontSize: 13 }} />
            {label}
          </Box>
        ))}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 0.75, ...tiny, color: 'text.secondary' }}>
        <AddRoundedIcon sx={{ fontSize: 14 }} />
        New session
      </Box>
      {SESSIONS.map(({ project, titles }) => (
        <Box key={project}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              px: 0.75,
              mb: 0.5,
              ...tiny,
              fontWeight: 600,
              color: 'text.secondary',
            }}
          >
            <FolderOutlinedIcon sx={{ fontSize: 13 }} />
            {project}
          </Box>
          {titles.map(title => (
            <Box
              key={title}
              sx={{
                px: 0.75,
                py: '5px',
                ml: 1.25,
                borderRadius: '6px',
                ...tiny,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: title === OPEN_SESSION ? 'text.primary' : 'text.tertiary',
                bgcolor: title === OPEN_SESSION ? 'background.level3' : 'transparent',
              }}
            >
              {title}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function ToolRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, ...tiny, color: 'text.tertiary' }}>
      {icon}
      {children}
    </Box>
  );
}

function ApprovalCard() {
  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: '10px',
        border: '1px solid',
        borderColor: 'primary.outlinedBorder',
        bgcolor: 'background.surface',
        boxShadow: 'sm',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, ...tiny, fontWeight: 600, color: 'text.primary' }}>
        <TerminalRoundedIcon sx={{ fontSize: 14, color: 'primary.plainColor' }} />
        Run a command?
      </Box>
      <Box
        component="code"
        sx={{
          display: 'block',
          mt: 0.75,
          px: 1,
          py: 0.5,
          borderRadius: '6px',
          bgcolor: 'background.level1',
          fontFamily: 'code',
          ...tiny,
          color: 'text.primary',
        }}
      >
        pnpm test upload
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
        <Box
          sx={{
            px: 1.25,
            py: '3px',
            borderRadius: '6px',
            ...tiny,
            fontWeight: 600,
            bgcolor: 'primary.solidBg',
            color: 'primary.solidColor',
          }}
        >
          Allow
        </Box>
        <Box sx={{ px: 1, ...tiny, color: 'text.secondary' }}>Deny</Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 'auto', ...tiny, color: 'text.tertiary' }}>
          <Box
            sx={{
              width: 10,
              height: 10,
              borderRadius: '3px',
              border: '1px solid',
              borderColor: 'neutral.outlinedBorder',
            }}
          />
          Always allow
        </Box>
      </Box>
    </Box>
  );
}

function Thread() {
  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1.5, p: { xs: 1.5, sm: 2 } }}>
      <Box
        sx={{
          alignSelf: 'flex-end',
          maxWidth: '82%',
          px: 1.5,
          py: 1,
          borderRadius: '12px',
          bgcolor: 'background.level2',
          ...small,
          color: 'text.primary',
          ...enter(0),
        }}
      >
        The upload test fails about one run in five. Can you find out why?
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, ...enter(1) }}>
        <ToolRow icon={<CheckRoundedIcon sx={{ fontSize: 13, color: 'success.plainColor' }} />}>
          Read src/upload.test.ts
        </ToolRow>
        <Typography sx={{ ...small, color: 'text.primary' }}>
          It waits a fixed 200 ms for the upload. I made it wait for the request to finish instead.
        </Typography>
        <ToolRow icon={<CheckRoundedIcon sx={{ fontSize: 13, color: 'success.plainColor' }} />}>
          Edited src/upload.test.ts
          <Box component="span" sx={{ color: 'success.plainColor', fontFamily: 'code' }}>
            +6
          </Box>
          <Box component="span" sx={{ color: 'danger.plainColor', fontFamily: 'code' }}>
            -2
          </Box>
        </ToolRow>
      </Box>
      <Box sx={enter(2)}>
        <ApprovalCard />
      </Box>
    </Box>
  );
}

function Composer() {
  return (
    <Box sx={{ px: { xs: 1.5, sm: 2 }, pb: { xs: 1.5, sm: 2 } }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          pl: 1.5,
          pr: 0.75,
          py: 0.75,
          borderRadius: '12px',
          border: '1px solid',
          borderColor: 'neutral.outlinedBorder',
          bgcolor: 'background.surface',
        }}
      >
        <Box sx={{ flex: 1, ...small, color: 'text.tertiary' }}>Reply...</Box>
        <Box sx={{ ...tiny, color: 'text.tertiary', display: { xs: 'none', sm: 'block' } }}>Code mode</Box>
        <Box
          sx={{
            display: 'grid',
            placeItems: 'center',
            width: 24,
            height: 24,
            borderRadius: '50%',
            bgcolor: 'primary.solidBg',
            color: 'primary.solidColor',
          }}
        >
          <ArrowUpwardRoundedIcon sx={{ fontSize: 15, color: 'inherit' }} />
        </Box>
      </Box>
    </Box>
  );
}

/** An illustration of the desktop app window, for the /desktop download page. */
export default function DesktopAppPreview() {
  return (
    <Box
      role="img"
      aria-label="The Bike4Mind desktop app working on a project in Code mode"
      data-testid="desktop-download-app-preview"
      sx={{
        borderRadius: '14px',
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
        bgcolor: 'background.surface',
        boxShadow: 'lg',
        userSelect: 'none',
        '& *': { pointerEvents: 'none' },
      }}
    >
      <Box
        aria-hidden
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          px: 1.75,
          height: 34,
          bgcolor: 'background.level1',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        {['#FF5F57', '#FEBC2E', '#28C840'].map(color => (
          <Box key={color} sx={{ width: 11, height: 11, borderRadius: '50%', bgcolor: color }} />
        ))}
        <Typography sx={{ flex: 1, textAlign: 'center', mr: '40px', ...tiny, color: 'text.tertiary' }}>
          Bike4Mind
        </Typography>
      </Box>
      <Box aria-hidden sx={{ display: 'flex', height: { xs: 380, sm: 420 } }}>
        <Sidebar />
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: { xs: 1.5, sm: 2 },
              height: 40,
              borderBottom: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Typography
              sx={{
                ...small,
                fontWeight: 600,
                color: 'text.primary',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {OPEN_SESSION}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                flexShrink: 0,
                px: 0.75,
                py: '1px',
                borderRadius: '999px',
                bgcolor: 'background.level1',
                fontFamily: 'code',
                ...tiny,
                color: 'text.secondary',
              }}
            >
              <CallSplitRoundedIcon sx={{ fontSize: 12 }} />
              fix/upload-wait
            </Box>
          </Box>
          <Thread />
          <Composer />
        </Box>
      </Box>
    </Box>
  );
}
