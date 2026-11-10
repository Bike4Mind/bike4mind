import type { PageWidget } from '@bike4mind/common';
import CardListWidget from './CardListWidget';
import ChecklistWidget from './ChecklistWidget';
import MarkdownWidget from './MarkdownWidget';

const PageWidgetRenderer = ({ pageId, widget }: { pageId: string; widget: PageWidget }) => {
  switch (widget.type) {
    case 'card-list':
      return <CardListWidget items={widget.items} />;
    case 'checklist':
      return <ChecklistWidget pageId={pageId} widgetId={widget.id} items={widget.items} />;
    case 'markdown':
      return <MarkdownWidget markdown={widget.markdown} />;
    default:
      return null;
  }
};

export default PageWidgetRenderer;
