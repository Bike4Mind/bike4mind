import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';

const MarkdownWidget = ({ markdown }: { markdown: string }) => <MarkdownViewer content={markdown} />;

export default MarkdownWidget;
