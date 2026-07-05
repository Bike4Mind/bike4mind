import { useGetFabFile, useGetFabFileContent } from '@client/app/hooks/data/fabFiles';
import { FC } from 'react';
import { CircularProgress } from '@mui/joy';

interface FileContentProps {
  id: string;
  children?: (content: string) => React.ReactNode;
}

const FileContent: FC<FileContentProps> = ({ id, children }) => {
  const { data: fabFile, isPending } = useGetFabFile(id);
  const { data: content, isPending: isContentPending } = useGetFabFileContent(fabFile);

  if (isPending || isContentPending) {
    return <CircularProgress className="file-content-loading" />;
  }

  if (!content) return null;

  if (children) {
    return children(content);
  }

  return <div className="file-content-container">{content}</div>;
};

export default FileContent;
