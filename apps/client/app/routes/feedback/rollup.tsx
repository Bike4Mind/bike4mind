/**
 * Personal feedback rollup (`/feedback/rollup`). The window arrives already resolved from the
 * route's `validateSearch`; the body is shared with the inbox Your feedback tab.
 */

import { FC } from 'react';
import { feedbackRollupRoute } from '@client/app/router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import FeedbackRollupView from '@client/app/components/feedback/FeedbackRollupView';

export { rollupBucketLabel } from '@client/app/components/feedback/FeedbackRollupView';

const FeedbackRollupPage: FC = () => {
  useDocumentTitle('Your feedback');
  const { from, to } = feedbackRollupRoute.useSearch();
  return <FeedbackRollupView from={from} to={to} />;
};

export default FeedbackRollupPage;
