import { FC } from 'react';
import { useParams } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import ListingDetail from '@client/app/components/SkillMarket/ListingDetail';

/** Unlisted listing opened from its share link. */
const UnlistedSkillListingPage: FC = () => {
  const { token } = useParams({ strict: false }) as { token: string };
  useDocumentTitle('Skill Market');
  return <ListingDetail token={token} />;
};

export default UnlistedSkillListingPage;
