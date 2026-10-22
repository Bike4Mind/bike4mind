import { FC } from 'react';
import { useParams } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import ListingDetail from '@client/app/components/SkillMarket/ListingDetail';

const SkillListingPage: FC = () => {
  const { listingId } = useParams({ strict: false }) as { listingId: string };
  useDocumentTitle('Skill Market');
  return <ListingDetail listingId={listingId} />;
};

export default SkillListingPage;
