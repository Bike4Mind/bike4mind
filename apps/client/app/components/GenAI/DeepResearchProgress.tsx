import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Card, Chip, CircularProgress, IconButton, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import { tabClasses } from '@mui/joy/Tab';
import type { SvgIconComponent } from '@mui/icons-material';
import SearchIcon from '@mui/icons-material/Search';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import InsertChartOutlinedIcon from '@mui/icons-material/InsertChartOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import CheckIcon from '@mui/icons-material/Check';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import {
  buildResearchSteps,
  formatElapsed,
  hostnameOf,
  type DeepResearchActivity,
  type DeepResearchSource,
  type ResearchStep,
} from './deepResearchSteps';
import { green } from '@client/app/utils/themes/colors';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

interface DeepResearchProgressProps {
  activities?: DeepResearchActivity[];
  sources?: DeepResearchSource[];
  completedSteps?: number;
  totalExpectedSteps?: number;
  /** The research reported completion. It does so before the report is written, so the
   *  run only counts as done once `turnDone` is set too. */
  researchCompleted?: boolean;
  /** The turn holding the panel has settled; with no completed research that means it stopped. */
  turnDone?: boolean;
  startTime?: number;
  endTime?: number;
}

type PanelStatus = 'running' | 'complete' | 'stopped';

const PANEL_HEIGHT = 420;
const PANEL_MAX_WIDTH = 560;

const STEP_ICON: Record<ResearchStep['kind'], SvgIconComponent> = {
  search: SearchIcon,
  read: DescriptionOutlinedIcon,
  analyze: InsertChartOutlinedIcon,
  write: EditOutlinedIcon,
  note: InfoOutlinedIcon,
};

function stepTitle(step: ResearchStep, active: boolean): string {
  switch (step.kind) {
    case 'search':
      return active ? 'Searching the web' : 'Searched the web';
    case 'read': {
      const what = step.sourceIndex ? `source ${step.sourceIndex}` : 'a page';
      if (step.status === 'error') return `Couldn't read ${what}`;
      return `${active ? 'Reading' : 'Read'} ${what}`;
    }
    case 'analyze':
      return active ? 'Comparing findings' : 'Compared findings';
    case 'write':
      return active ? 'Writing the report' : 'Wrote the report';
    case 'note':
      return step.status === 'error' ? 'Research stopped' : 'Note';
  }
}

function currentLabel(step: ResearchStep | undefined, sourceCount: number): string {
  if (!step) return 'Starting';
  if (step.kind === 'read' && step.sourceIndex) return `Reading source ${step.sourceIndex} of ${sourceCount}`;
  return stepTitle(step, true);
}

const Spinner = ({ size }: { size: number }) => (
  <CircularProgress
    aria-hidden
    sx={{
      '--CircularProgress-size': `${size}px`,
      '--CircularProgress-trackThickness': '2px',
      '--CircularProgress-progressThickness': '2px',
      flexShrink: 0,
    }}
  />
);

/** Text clamped to a few lines once it is long enough to need it, with a toggle to read all of it. */
function ClampedText({
  text,
  lines,
  more,
  sx,
  leading,
}: {
  text: string;
  lines: number;
  more: string;
  sx?: React.ComponentProps<typeof Typography>['sx'];
  /** Shares the toggle's row, on its left. */
  leading?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  // Measured rather than guessed from the length: whether the clamp cuts anything depends
  // on the panel's width, so the toggle shows only when there is more to read.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);

  const long = clipped || open;
  return (
    <>
      <Typography
        ref={textRef}
        sx={[
          { overflowWrap: 'anywhere', m: 0 },
          !open
            ? { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
            : {},
          ...(Array.isArray(sx) ? sx : [sx]),
        ]}
      >
        {text}
      </Typography>
      {(long || leading) && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {leading}
          {long && (
            <Typography
              component="button"
              type="button"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              sx={{
                ml: 'auto',
                border: 0,
                p: '2px 0',
                bgcolor: 'transparent',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: '12px',
                color: 'primary.plainColor',
              }}
            >
              {open ? 'Show less' : more}
            </Typography>
          )}
        </Box>
      )}
    </>
  );
}

function StepRow({
  step,
  active,
  last,
  sources,
}: {
  step: ResearchStep;
  active: boolean;
  last: boolean;
  sources: DeepResearchSource[];
}) {
  const Icon = step.status === 'error' && step.kind === 'note' ? ErrorOutlineIcon : STEP_ICON[step.kind];
  const source = step.kind === 'read' && step.sourceIndex ? sources[step.sourceIndex - 1] : undefined;

  return (
    <Box component="li" sx={{ display: 'flex', gap: '12px' }} data-testid={`deep-research-step-${step.kind}`}>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 28, flexShrink: 0 }}>
        <Box
          sx={{
            width: 28,
            height: 28,
            borderRadius: 'sm',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: active ? 'primary.softBg' : 'neutral.softBg',
            color: active ? 'primary.plainColor' : step.status === 'error' ? 'danger.plainColor' : 'text.secondary',
            boxShadow: active ? theme => `0 0 0 1px ${theme.vars.palette.primary.outlinedBorder}` : 'none',
          }}
        >
          <Icon sx={{ fontSize: 16, color: 'inherit' }} />
        </Box>
        {!last && <Box sx={{ width: 2, flex: 1, minHeight: 12, my: '4px', bgcolor: 'reading.line2' }} />}
      </Box>

      <Box sx={{ flex: 1, minWidth: 0, pt: '4px', pb: '18px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Typography sx={{ fontSize: '13px', lineHeight: '18px', fontWeight: 600, color: 'text.primary' }}>
            {stepTitle(step, active)}
          </Typography>
          {active && <Spinner size={10} />}
          <Typography sx={{ ml: 'auto', fontFamily: 'code', fontSize: '11px', color: 'text.tertiary', flexShrink: 0 }}>
            {formatElapsed(step.elapsedSec)}
          </Typography>
        </Box>

        {step.kind === 'search' && (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <ClampedText
              text={step.query}
              lines={2}
              more="Full query"
              sx={{ fontFamily: 'code', fontSize: '12px', lineHeight: '18px', color: 'reading.ink2' }}
              leading={
                (step.resultCount != null || step.status === 'error') && (
                  <Chip size="sm" variant="soft" color={step.status === 'error' ? 'danger' : 'success'}>
                    {step.status === 'error'
                      ? 'Search failed'
                      : `${step.resultCount} ${step.resultCount === 1 ? 'result' : 'results'}`}
                  </Chip>
                )
              }
            />
          </Box>
        )}

        {step.kind === 'read' && (
          <>
            <Typography
              sx={{ fontSize: '12px', lineHeight: '17px', color: 'text.secondary', overflowWrap: 'anywhere' }}
            >
              {source?.title || hostnameOf(step.url) || step.url}
              {step.error ? ` \u00b7 ${step.error}` : ''}
            </Typography>
            {source?.description && (
              <ClampedText
                text={source.description}
                lines={2}
                more="Show more"
                sx={{ fontSize: '12px', lineHeight: '17px', color: 'text.tertiary' }}
              />
            )}
          </>
        )}

        {(step.kind === 'analyze' || step.kind === 'write' || step.kind === 'note') && step.detail && (
          <ClampedText
            text={step.detail}
            lines={3}
            more="Show more"
            sx={{ fontSize: '12px', lineHeight: '17px', color: 'text.secondary' }}
          />
        )}
      </Box>
    </Box>
  );
}

function SourceCard({ source }: { source: DeepResearchSource }) {
  const host = hostnameOf(source.url);
  const linkable = /^https?:\/\//.test(source.url) || source.url.startsWith('/');
  return (
    <Box
      component={linkable ? 'a' : 'div'}
      {...(linkable ? { href: source.url, target: '_blank', rel: 'noopener noreferrer' } : {})}
      data-testid="deep-research-source"
      sx={{
        display: 'flex',
        p: '12px',
        bgcolor: 'reading.surface',
        border: '1px solid',
        borderColor: 'reading.line',
        borderRadius: 'md',
        textDecoration: 'none',
        color: 'text.primary',
        transition: 'border-color 150ms ease',
        ...(linkable && { '&:hover': { borderColor: 'reading.accentLine' } }),
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: '13px', lineHeight: '18px', fontWeight: 600, overflowWrap: 'anywhere' }}>
          {source.title || host || source.url}
        </Typography>
        {source.description && (
          <Typography
            sx={{
              fontSize: '12px',
              lineHeight: '17px',
              color: 'text.secondary',
              overflowWrap: 'anywhere',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {source.description}
          </Typography>
        )}
        <Typography sx={{ fontFamily: 'code', fontSize: '11px', color: 'text.tertiary', overflowWrap: 'anywhere' }}>
          {host ?? 'Internal'}
        </Typography>
      </Box>
    </Box>
  );
}

const DeepResearchProgress: React.FC<DeepResearchProgressProps> = ({
  activities = [],
  sources = [],
  completedSteps = 0,
  totalExpectedSteps = 0,
  researchCompleted = false,
  turnDone = false,
  startTime,
  endTime,
}) => {
  const [tab, setTab] = useState<'activity' | 'sources'>('activity');
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const status: PanelStatus = !turnDone ? 'running' : researchCompleted ? 'complete' : 'stopped';
  const running = status === 'running';

  const startMs = useMemo(() => {
    if (startTime) return startTime;
    const first = activities[0] && Date.parse(activities[0].timestamp);
    return first || mountedAt;
  }, [startTime, activities, mountedAt]);

  const steps = useMemo(() => buildResearchSteps(activities, sources, startMs), [activities, sources, startMs]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Follows new steps only while the reader is already at the bottom, so scrolling back
  // to an earlier search is not undone by the next event.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [steps.length, tab, collapsed]);

  if (!activities.length && !sources.length) {
    return null;
  }

  const lastTs = activities.length ? Date.parse(activities[activities.length - 1].timestamp) : startMs;
  const elapsedSec = ((running ? now : endTime || lastTs || now) - startMs) / 1000;
  const percent =
    status === 'complete'
      ? 100
      : Math.min(totalExpectedSteps > 0 ? Math.round((completedSteps / totalExpectedSteps) * 100) : 0, 100);
  const results = steps.reduce((n, s) => n + (s.kind === 'search' ? (s.resultCount ?? 0) : 0), 0);
  // With nothing pending the run is between events (or writing the report after the last
  // one), and the newest step is the one still in progress.
  const activeStep = running
    ? ([...steps].reverse().find(s => s.status === 'pending') ?? steps[steps.length - 1])
    : undefined;
  const summary = `${results} ${results === 1 ? 'result' : 'results'} \u00b7 ${sources.length} ${
    sources.length === 1 ? 'source' : 'sources'
  } \u00b7 ${formatElapsed(elapsedSec)}`;
  const subtitle = running
    ? `${currentLabel(activeStep, sources.length)} \u00b7 ${formatElapsed(elapsedSec)}`
    : `${status === 'complete' ? 'Done' : 'Stopped'} \u00b7 ${summary}`;

  return (
    <Card
      variant="outlined"
      component="section"
      aria-label="Deep research progress"
      data-testid="deep-research-panel"
      sx={theme => ({
        // The artifact-card frame, so the panel belongs to the same family as the cards a
        // reply puts below it.
        backgroundColor: theme.palette.reading.cardBase,
        backgroundImage: `linear-gradient(180deg, ${theme.palette.reading.cardTintTop}, ${theme.palette.reading.cardTintBottom})`,
        borderColor: theme.palette.reading.cardLine,
        borderRadius: 'lg',
        p: 0,
        gap: 0,
        width: '100%',
        maxWidth: PANEL_MAX_WIDTH,
        overflow: 'hidden',
        mt: 2,
        mb: '32px',
      })}
    >
      <Box sx={{ p: '16px 20px 14px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        {running ? (
          <Spinner size={14} />
        ) : (
          <Box
            sx={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              // The composer's CountBadge green, so a finished run reads like its other done marks.
              bgcolor: status === 'complete' ? `${green[800]}26` : 'danger.softBg',
              color: status === 'complete' ? green[800] : 'danger.plainColor',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {status === 'complete' ? (
              <CheckIcon sx={{ fontSize: 12, color: 'inherit' }} />
            ) : (
              <ErrorOutlineIcon sx={{ fontSize: 12, color: 'inherit' }} />
            )}
          </Box>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            component="h2"
            sx={{ fontSize: '15px', lineHeight: '20px', fontWeight: 600, color: 'text.primary' }}
          >
            Deep Research
          </Typography>
          <Typography
            data-testid="deep-research-status"
            sx={{
              fontSize: '12px',
              lineHeight: '16px',
              color: 'text.secondary',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {subtitle}
          </Typography>
        </Box>
        <Typography
          data-testid="deep-research-percent"
          sx={{ fontFamily: 'code', fontSize: '15px', fontWeight: 500, color: 'text.primary' }}
        >
          {percent}%
        </Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(c => !c)}
          data-testid="deep-research-collapse-btn"
        >
          <KeyboardArrowUpIcon
            sx={{ fontSize: 18, transform: collapsed ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
          />
        </IconButton>
      </Box>

      {!collapsed && <Box sx={{ borderTop: '1px solid', borderColor: 'reading.cardLine' }} />}

      {!collapsed && (
        <Tabs value={tab} onChange={(_, v) => setTab(v as 'activity' | 'sources')} sx={{ bgcolor: 'transparent' }}>
          {/* Pills sized to their label: the active one is set darker than the panel, the
              other is bare text until hovered. */}
          <TabList
            disableUnderline
            aria-label="Research details"
            sx={{
              m: '16px 20px 0',
              gap: '4px',
              justifyContent: 'flex-start',
              bgcolor: 'transparent',
              [`& .${tabClasses.root}`]: {
                flex: 'none',
                minHeight: 32,
                px: '12px',
                py: 0,
                gap: '6px',
                borderRadius: '999px',
                fontSize: '13px',
                fontWeight: 500,
                color: 'text.tertiary',
                bgcolor: 'transparent',
                transition: 'color 150ms ease, background-color 150ms ease',
                '&:hover': { color: 'text.secondary', bgcolor: 'neutral.plainHoverBg' },
              },
              [`& .${tabClasses.root}.${tabClasses.selected}`]: {
                color: 'text.primary',
                fontWeight: 600,
                bgcolor: 'background.body',
                '&:hover': { bgcolor: 'background.body' },
              },
            }}
          >
            <Tab value="activity" disableIndicator data-testid="deep-research-tab-activity">
              Activity{' '}
              <Box component="span" sx={{ color: 'text.tertiary', fontVariantNumeric: 'tabular-nums' }}>
                {steps.length}
              </Box>
            </Tab>
            <Tab value="sources" disableIndicator data-testid="deep-research-tab-sources">
              Sources{' '}
              <Box component="span" sx={{ color: 'text.tertiary', fontVariantNumeric: 'tabular-nums' }}>
                {sources.length}
              </Box>
            </Tab>
          </TabList>

          <TabPanel value="activity" sx={{ p: 0 }}>
            <Box
              ref={listRef}
              onScroll={e => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
              sx={{
                ...scrollbarStyles,
                maxHeight: PANEL_HEIGHT,
                overflowY: 'auto',
                overflowX: 'hidden',
                p: '24px 14px 0 20px',
              }}
            >
              <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
                {steps.map((step, i) => (
                  <StepRow
                    key={step.id}
                    step={step}
                    active={running && (step.status === 'pending' || step === activeStep)}
                    last={i === steps.length - 1}
                    sources={sources}
                  />
                ))}
              </Box>
            </Box>
          </TabPanel>

          <TabPanel value="sources" sx={{ p: 0 }}>
            <Box
              sx={{
                ...scrollbarStyles,
                maxHeight: PANEL_HEIGHT,
                overflowY: 'auto',
                overflowX: 'hidden',
                p: '14px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              {sources.length ? (
                sources.map((source, i) => <SourceCard key={`${source.url}-${i}`} source={source} />)
              ) : (
                <Typography sx={{ fontSize: '12px', color: 'text.secondary', textAlign: 'center', py: 2 }}>
                  No sources found yet
                </Typography>
              )}
            </Box>
          </TabPanel>
        </Tabs>
      )}
    </Card>
  );
};

export default DeepResearchProgress;
