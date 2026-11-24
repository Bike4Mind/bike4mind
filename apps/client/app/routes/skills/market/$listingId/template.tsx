import { FC } from 'react';
import { useParams } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import TemplateEditor from '@client/app/components/SkillMarket/TemplateEditor/TemplateEditor';

const SkillTemplateEditorPage: FC = () => {
  const { listingId } = useParams({ strict: false }) as { listingId: string };
  useDocumentTitle('Template page');
  return <TemplateEditor key={listingId} listingId={listingId} />;
};

export default SkillTemplateEditorPage;
