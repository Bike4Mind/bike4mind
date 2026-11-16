import { Alert, Button } from '@mui/joy';
import { useAccessReviewStatus } from '@client/app/hooks/data/adminAccessReview';

type AccessReviewOverdueBannerProps = {
  /** Only full admins can run the review, so only they see the banner. */
  isFullAdmin: boolean;
  onOpen: () => void;
};

export function AccessReviewOverdueBanner({ isFullAdmin, onOpen }: AccessReviewOverdueBannerProps) {
  const { data } = useAccessReviewStatus(isFullAdmin);
  if (!isFullAdmin || !data?.overdue) return null;
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
