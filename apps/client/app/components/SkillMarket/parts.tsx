import { FC, ReactElement, useMemo, useState } from 'react';
import { Alert, Box, Chip, List, ListItem, ListItemDecorator, Sheet, Stack, Tooltip, Typography } from '@mui/joy';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import StarHalfIcon from '@mui/icons-material/StarHalf';
import PublicIcon from '@mui/icons-material/Public';
import GroupsIcon from '@mui/icons-material/Groups';
import LinkIcon from '@mui/icons-material/Link';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import ErrorIcon from '@mui/icons-material/Error';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { diffLines } from 'diff';
import type {
  ISkillFile,
  ISkillHonestSummary,
  ISkillScanFinding,
  SkillListingVisibility,
  SkillRiskTier,
  SkillScanSeverity,
} from '@bike4mind/common';

/** Shared presentation pieces for the Skill Market pages. Everything user-authored renders as text. */

export const Stars: FC<{ value: number; size?: 'sm' | 'md'; testId?: string }> = ({ value, size = 'sm', testId }) => {
  const fontSize = size === 'sm' ? 16 : 22;
  return (
    <Stack
      direction="row"
      sx={{ color: 'warning.400' }}
      aria-label={`${value.toFixed(1)} out of 5 stars`}
      data-testid={testId}
    >
      {[1, 2, 3, 4, 5].map(i =>
        value >= i ? (
          <StarIcon key={i} sx={{ fontSize }} />
        ) : value >= i - 0.5 ? (
          <StarHalfIcon key={i} sx={{ fontSize }} />
        ) : (
          <StarBorderIcon key={i} sx={{ fontSize }} />
        )
      )}
    </Stack>
  );
};

/** Clickable 1-5 star picker for the rating form. */
export const StarInput: FC<{ value: number; onChange: (v: number) => void }> = ({ value, onChange }) => {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <Stack direction="row" onMouseLeave={() => setHover(0)} role="radiogroup" aria-label="Your rating">
      {[1, 2, 3, 4, 5].map(i => (
        <Box
          key={i}
          component="button"
          type="button"
          role="radio"
          aria-checked={value === i}
          aria-label={`${i} star${i > 1 ? 's' : ''}`}
          onMouseEnter={() => setHover(i)}
          onClick={() => onChange(i)}
          data-testid={`market-rate-star-${i}`}
          sx={{
            border: 0,
            bgcolor: 'transparent',
            p: 0.25,
            cursor: 'pointer',
            color: shown >= i ? 'warning.400' : 'neutral.400',
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.500', borderRadius: '4px' },
          }}
        >
          {shown >= i ? <StarIcon /> : <StarBorderIcon />}
        </Box>
      ))}
    </Stack>
  );
};

const VISIBILITY: Record<SkillListingVisibility, { label: string; icon: ReactElement }> = {
  public: { label: 'Public', icon: <PublicIcon /> },
  organization: { label: 'Organization', icon: <GroupsIcon /> },
  unlisted: { label: 'Unlisted', icon: <LinkIcon /> },
};

export const VisibilityChip: FC<{ visibility: SkillListingVisibility }> = ({ visibility }) => (
  <Chip size="sm" variant="soft" color="neutral" startDecorator={VISIBILITY[visibility].icon}>
    {VISIBILITY[visibility].label}
  </Chip>
);

const TIER: Record<SkillRiskTier, { label: string; color: 'success' | 'warning' | 'danger'; hint: string }> = {
  clean: { label: 'Low risk', color: 'success', hint: 'No findings that need a human' },
  review: {
    label: 'Needs a look',
    color: 'warning',
    hint: 'Medium findings, low classifier confidence, or a description mismatch',
  },
  high: { label: 'High risk', color: 'danger', hint: 'Declares tools that act outside the conversation' },
};

export const TierChip: FC<{ tier?: SkillRiskTier }> = ({ tier }) =>
  tier ? (
    <Tooltip title={TIER[tier].hint} variant="soft">
      <Chip size="sm" variant="soft" color={TIER[tier].color} data-testid={`market-tier-${tier}`}>
        {TIER[tier].label}
      </Chip>
    </Tooltip>
  ) : null;

const SEVERITY_ICON: Record<SkillScanSeverity, ReactElement> = {
  critical: <ErrorIcon color="error" />,
  high: <ReportProblemIcon sx={{ color: 'danger.400' }} />,
  medium: <WarningAmberIcon sx={{ color: 'warning.500' }} />,
  low: <InfoOutlinedIcon sx={{ color: 'neutral.400' }} />,
};

const SEVERITY_ORDER: SkillScanSeverity[] = ['critical', 'high', 'medium', 'low'];

export const FindingsList: FC<{ findings: ISkillScanFinding[]; emptyText?: string }> = ({ findings, emptyText }) => {
  if (findings.length === 0) {
    return emptyText ? (
      <Typography level="body-sm" textColor="text.tertiary">
        {emptyText}
      </Typography>
    ) : null;
  }
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return (
    <List size="sm" sx={{ '--ListItem-paddingX': 0 }} data-testid="market-findings">
      {sorted.map((f, i) => (
        <ListItem key={`${f.rule}-${i}`} sx={{ alignItems: 'flex-start' }}>
          <ListItemDecorator sx={{ mt: 0.25 }}>{SEVERITY_ICON[f.severity]}</ListItemDecorator>
          <Box sx={{ minWidth: 0 }}>
            <Typography level="body-sm" fontWeight="md">
              {f.message}
              <Typography level="body-xs" textColor="text.tertiary" sx={{ ml: 1 }}>
                {f.severity} - {f.source === 'rules' ? 'rule' : 'AI review'}
              </Typography>
            </Typography>
            {f.excerpt ? (
              <Typography
                level="body-xs"
                component="code"
                sx={{ display: 'block', mt: 0.5, fontFamily: 'code', wordBreak: 'break-word', color: 'text.secondary' }}
              >
                {f.excerpt}
              </Typography>
            ) : null}
          </Box>
        </ListItem>
      ))}
    </List>
  );
};

export const MismatchAlert: FC<{ note?: string }> = ({ note }) => (
  <Alert color="warning" variant="soft" startDecorator={<WarningAmberIcon />} data-testid="market-mismatch-alert">
    <Box>
      <Typography level="title-sm">Description may not match behaviour</Typography>
      <Typography level="body-sm">
        {note || "The automated review found that the author's description doesn't fully describe what the skill does."}
      </Typography>
    </Box>
  </Alert>
);

/** "What this skill actually does" - machine-generated from the body + tools, never author-editable. */
export const HonestSummaryPanel: FC<{ summary?: ISkillHonestSummary; tools?: string[] }> = ({ summary, tools }) => (
  <Sheet
    variant="soft"
    color="primary"
    sx={{ p: 2, borderRadius: 'md', display: 'flex', flexDirection: 'column', gap: 1 }}
    data-testid="market-honest-summary"
  >
    <Stack direction="row" spacing={1} alignItems="center">
      <AutoAwesomeIcon fontSize="small" />
      <Typography level="title-sm">What this skill actually does</Typography>
    </Stack>
    <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: -0.5 }}>
      AI-generated from the skill content, not written by the author.
    </Typography>
    {summary ? (
      <>
        <Typography level="body-md">{summary.whatItDoes}</Typography>
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
          <Box>
            <Typography level="body-xs" textColor="text.tertiary">
              Data it touches
            </Typography>
            <Typography level="body-sm">{summary.dataItTouches || 'Nothing beyond your message'}</Typography>
          </Box>
          <Box>
            <Typography level="body-xs" textColor="text.tertiary">
              Tools
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {(tools?.length ? tools : summary.toolsUsed).length ? (
                (tools?.length ? tools : summary.toolsUsed).map(t => (
                  <Chip key={t} size="sm" variant="outlined">
                    {t}
                  </Chip>
                ))
              ) : (
                <Typography level="body-sm">None</Typography>
              )}
            </Stack>
          </Box>
        </Stack>
        {summary.riskNotes.length ? (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {summary.riskNotes.map(n => (
              <Typography key={n} component="li" level="body-sm">
                {n}
              </Typography>
            ))}
          </Box>
        ) : null}
      </>
    ) : (
      <Typography level="body-sm" textColor="text.tertiary">
        Not available yet.
      </Typography>
    )}
  </Sheet>
);

/** Line diff of two skill bodies (added lines green, removed red). */
export const BodyDiff: FC<{ before: string; after: string; testId?: string }> = ({ before, after, testId }) => {
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  const unchanged = parts.every(p => !p.added && !p.removed);
  return (
    <Box
      component="pre"
      data-testid={testId ?? 'market-body-diff'}
      sx={{
        m: 0,
        p: 1.5,
        maxHeight: 420,
        overflow: 'auto',
        fontFamily: 'code',
        fontSize: 'sm',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
      }}
    >
      {unchanged ? (
        <Typography level="body-sm" textColor="text.tertiary">
          No changes to the body.
        </Typography>
      ) : (
        parts.map((p, i) => (
          <Box
            key={i}
            component="span"
            sx={{
              display: 'block',
              bgcolor: p.added ? 'success.softBg' : p.removed ? 'danger.softBg' : 'transparent',
              color: p.added ? 'success.softColor' : p.removed ? 'danger.softColor' : 'text.secondary',
              textDecoration: p.removed ? 'line-through' : 'none',
            }}
          >
            {p.value
              .replace(/\n$/, '')
              .split('\n')
              .map(line => `${p.added ? '+ ' : p.removed ? '- ' : '  '}${line}`)
              .join('\n')}
          </Box>
        ))
      )}
    </Box>
  );
};

/** Read-only skill body block. */
export const BodyBlock: FC<{ body: string; testId?: string }> = ({ body, testId }) => (
  <Box
    component="pre"
    data-testid={testId}
    sx={{
      m: 0,
      p: 2,
      maxHeight: 480,
      overflow: 'auto',
      fontFamily: 'code',
      fontSize: 'sm',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      borderRadius: 'sm',
      border: '1px solid',
      borderColor: 'divider',
      bgcolor: 'background.level1',
    }}
  >
    {body}
  </Box>
);

export const formatCount = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);

/** A version's supporting files, each expandable to its full text so a reviewer reads what they approve. */
export const SupportingFiles: FC<{ files?: ISkillFile[] }> = ({ files }) =>
  files?.length ? (
    <Box data-testid="market-supporting-files">
      <Typography level="title-sm" sx={{ mb: 1 }}>
        Supporting files ({files.length})
      </Typography>
      <Stack spacing={1}>
        {files.map(f => (
          <Box key={f.path} component="details" data-testid="market-supporting-file">
            <Typography component="summary" level="body-sm" sx={{ cursor: 'pointer', fontFamily: 'code' }}>
              {f.path}
              {f.path.startsWith('scripts/') ? (
                <Chip size="sm" variant="soft" color="warning" sx={{ ml: 1 }}>
                  runs on the user&apos;s machine
                </Chip>
              ) : null}
            </Typography>
            <Box sx={{ mt: 1 }}>
              <BodyBlock body={f.content} />
            </Box>
          </Box>
        ))}
      </Stack>
    </Box>
  ) : null;
