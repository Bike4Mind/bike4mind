import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { PrSummary } from '@shared/pullRequest';
import { SessionBadge } from '../chat/SessionBadge';
import { PrStateIcon, prIconLabel } from '../chat/prStateStyle';
import type { Story, StoryDefault } from './ladleTypes';
import { Row, Section } from './matrix';

export default { title: 'PR status' } satisfies StoryDefault;

const SUMMARIES: PrSummary[] = [
  { number: 101, state: 'open', attention: 'conflict' },
  { number: 102, state: 'open', attention: 'ciFailed' },
  { number: 103, state: 'open', attention: 'changesRequested' },
  { number: 104, state: 'open', attention: 'ciRunning' },
  { number: 105, state: 'open', attention: 'awaitingReview' },
  { number: 106, state: 'open', attention: 'approvedBlocked' },
  { number: 107, state: 'open', attention: 'ready' },
  { number: 108, state: 'open', attention: 'ready', behind: true },
  { number: 109, state: 'open', attention: 'approvedBlocked', autoMerge: true },
  { number: 110, state: 'open', attention: 'ciRunning', behind: true, autoMerge: true },
  { number: 111, state: 'open', attention: 'changesRequested', stale: true },
  { number: 112, state: 'draft' },
  { number: 113, state: 'queued' },
  { number: 114, state: 'merged' },
  { number: 115, state: 'closed' },
];

/** Every PR icon state, at the sidebar's size and enlarged, each with the words it is named by. */
export const Icons: Story = () => (
  <>
    <Section title="sidebar badge (14px)">
      <Stack spacing={1}>
        {SUMMARIES.map(pr => (
          <Row key={pr.number}>
            <SessionBadge status="done" pr={pr} />
            <Typography level="body-sm">{prIconLabel(pr.number, pr)}</Typography>
          </Row>
        ))}
      </Stack>
    </Section>
    <Section title="enlarged (32px)">
      <Row>
        {SUMMARIES.map(pr => (
          <PrStateIcon key={pr.number} status={pr} size={32} label={prIconLabel(pr.number, pr)} />
        ))}
      </Row>
    </Section>
  </>
);
