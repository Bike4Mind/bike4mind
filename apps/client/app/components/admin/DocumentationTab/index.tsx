import React, { useState, useMemo, useEffect, type ReactNode } from 'react';
import { Box, Button, Sheet, Stack } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';

import { DocSection } from './components/DocSection';
import {
  fetchDocusaurusData,
  DOCUMENTATION_CATEGORY_LABELS,
  isDocumentationCategory,
  type DocumentationCategory,
  type DocumentationItem,
} from './utils/docData';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import {
  AdminPageHeader,
  AdminSearchInput,
  EmptyState,
  ErrorState,
  LoadingState,
  UpdatingBar,
  ViewTabs,
  type ViewTab,
} from '../shared';
import { ADMIN_REGION_GAP, adminSurface } from '../shared/adminStyles';

const CATEGORY_TABS: readonly ViewTab[] = [
  { id: 'all', label: 'All' },
  ...Object.entries(DOCUMENTATION_CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
];

const StateSurface: React.FC<{ children: ReactNode }> = ({ children }) => (
  <Sheet variant="outlined" sx={{ ...adminSurface, borderRadius: 'lg' }}>
    {children}
  </Sheet>
);

const DocumentationTab: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<DocumentationCategory | 'all'>('all');
  // null until the first load succeeds, so a failed refresh keeps the docs already on screen.
  const [documentationData, setDocumentationData] = useState<DocumentationItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability -- loadDocumentation calls state setters from an effect; calling setters from effects is valid React; React Compiler incorrectly flags the async init pattern
    loadDocumentation();
  }, []);

  const loadDocumentation = async () => {
    setLoading(true);
    setError(null);
    try {
      setDocumentationData(await fetchDocusaurusData());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const filteredDocs = useMemo(() => {
    let docs = documentationData ?? [];

    if (selectedCategory !== 'all') {
      docs = docs.filter(doc => doc.category === selectedCategory);
    }

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      docs = docs.filter(
        doc =>
          doc.title.toLowerCase().includes(term) ||
          doc.description.toLowerCase().includes(term) ||
          doc.tags.some(tag => tag.toLowerCase().includes(term))
      );
    }

    return docs;
  }, [searchTerm, selectedCategory, documentationData]);

  const refreshButton = (testId: string) => (
    <Button
      size="sm"
      variant="outlined"
      color="neutral"
      startDecorator={<RefreshIcon />}
      loading={loading}
      onClick={loadDocumentation}
      data-testid={testId}
      sx={{ whiteSpace: 'nowrap' }}
    >
      Refresh
    </Button>
  );

  const errorState = error && (
    <StateSurface>
      <ErrorState message={`Docs failed to load. ${error}`} onRetry={loadDocumentation} retrying={loading} />
    </StateSurface>
  );

  const categoryLabel = selectedCategory === 'all' ? null : DOCUMENTATION_CATEGORY_LABELS[selectedCategory];

  let body: ReactNode;
  if (documentationData === null) {
    body = loading ? (
      <StateSurface>
        <LoadingState label="Loading docs" testId="documentation-loading" />
      </StateSurface>
    ) : (
      errorState
    );
  } else if (documentationData.length === 0) {
    body = (
      <StateSurface>
        <EmptyState
          title="No docs found"
          description="This deployment has no docs site configured."
          action={refreshButton('documentation-empty-refresh-btn')}
        />
      </StateSurface>
    );
  } else if (filteredDocs.length === 0) {
    body = (
      <StateSurface>
        {searchTerm.trim() ? (
          <EmptyState
            title={`No docs match "${searchTerm.trim()}"`}
            description={categoryLabel ? `Searched in ${categoryLabel}.` : undefined}
            action={
              <Button
                size="sm"
                variant="outlined"
                onClick={() => setSearchTerm('')}
                data-testid="documentation-empty-clear-search-btn"
              >
                Clear search
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={`No docs in ${categoryLabel}`}
            action={
              <Button
                size="sm"
                variant="outlined"
                onClick={() => setSelectedCategory('all')}
                data-testid="documentation-empty-show-all-btn"
              >
                Show all docs
              </Button>
            }
          />
        )}
      </StateSurface>
    );
  } else {
    body = (
      <Box
        data-testid="documentation-doc-grid"
        sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(17.5rem, 1fr))', gap: 2 }}
      >
        {filteredDocs.map(doc => (
          <DocSection key={doc.id} doc={doc} />
        ))}
      </Box>
    );
  }

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="admin-documentation-tab">
      <AdminPageHeader
        title="Docs"
        count={documentationData ? filteredDocs.length : undefined}
        description="Platform docs by category. Search titles, descriptions and tags."
        actions={
          <>
            {refreshButton('documentation-refresh-btn')}
            <ContextHelpButton helpId="admin/documentation" tooltipText="Docs help" />
          </>
        }
      />
      <ViewTabs
        views={CATEGORY_TABS}
        activeId={selectedCategory}
        onSelect={id => setSelectedCategory(isDocumentationCategory(id) ? id : 'all')}
        aria-label="Doc categories"
        data-testid="documentation-category-tabs"
      />
      <Stack direction="row">
        <AdminSearchInput
          value={searchTerm}
          onChange={setSearchTerm}
          label="Search docs"
          data-testid="documentation-search-input"
        />
      </Stack>
      <UpdatingBar active={loading && documentationData !== null} testId="documentation-updating" />
      {documentationData !== null && errorState}
      {body}
    </Stack>
  );
};

export default DocumentationTab;
