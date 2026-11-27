import { Alert, Button } from '@mui/joy';
import { useAccessReviewStatus } from '@client/app/hooks/data/adminAccessReview';

type AccessReviewOverdueBannerProps = {
  /** Only full admins can run the review, so only they see the banner. */
  isFullAdmin: boolean;
  /** On the review page itself, which shows its own progress banner instead of a link to itself. */
  hidden: boolean;
  onOpen: () => void;
};

export function AccessReviewOverdueBanner({ isFullAdmin, hidden, onOpen }: AccessReviewOverdueBannerProps) {
  const { data } = useAccessReviewStatus(isFullAdmin);
  if (!isFullAdmin || hidden || !data?.overdue) return null;
  return (
    <Alert
      color="warning"
      data-testid="admin-access-review-overdue-banner"
      endDecorator={
        <Button
          size="sm"
          variant="solid"
          color="warning"
          onClick={onOpen}
          data-testid="admin-access-review-overdue-open-btn"
        >
          Open access review
        </Button>
      }
    >
      The {data.quarter} admin access review is overdue.
    </Alert>
  );
}

const DATE_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * A calendar date such as "Nov 3, 2026", in UTC so it matches the quarter boundaries the server uses.
 * Null for a missing or unparseable value, which `Intl` would otherwise throw on.
 */
export const formatReviewDate = (at: string | null | undefined): string | null => {
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time) ? null : DATE_FORMAT.format(time);
};

/** The review page's own overdue banner: progress instead of a link back to the page. */
export function AccessReviewProgressBanner({
  pending,
  total,
  overdueSince,
}: {
  pending: number;
  total: number;
  overdueSince: string;
}) {
  const overdueDate = formatReviewDate(overdueSince);
  return (
    <Alert color="warning" data-testid="admin-access-review-progress-banner">
      {pending} of {total} still pending{overdueDate ? `, overdue since ${overdueDate}` : ', overdue'}.
    </Alert>
  );
}
