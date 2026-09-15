import React, { useState, useMemo, useEffect } from 'react';
import { Box, Stack, Typography, Card, Grid, Chip, Divider, CircularProgress, Alert, Button } from '@mui/joy';
import DescriptionIcon from '@mui/icons-material/Description';
import SettingsIcon from '@mui/icons-material/Settings';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import CodeIcon from '@mui/icons-material/Code';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import ApiIcon from '@mui/icons-material/Api';
import RefreshIcon from '@mui/icons-material/Refresh';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import FeaturedPlayListIcon from '@mui/icons-material/FeaturedPlayList';
import CloudIcon from '@mui/icons-material/Cloud';
import ExtensionIcon from '@mui/icons-material/Extension';
import SecurityIcon from '@mui/icons-material/Security';
import StorageIcon from '@mui/icons-material/Storage';
import BugReportIcon from '@mui/icons-material/BugReport';
import SchoolIcon from '@mui/icons-material/School';
import FolderIcon from '@mui/icons-material/Folder';
import HelpIcon from '@mui/icons-material/Help';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';

import { DocSection } from './components/DocSection';
import { SearchBar } from './components/SearchBar';
import { fetchDocusaurusData, DocumentationCategory, DocumentationItem } from './utils/docData';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

const DocumentationTab: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<DocumentationCategory | 'all'>('all');
  const [documentationData, setDocumentationData] = useState<DocumentationItem[]>([]);
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
      const docusaurusData = await fetchDocusaurusData();

      if (docusaurusData.length === 0) {
        setError('No documentation found. Make sure Docusaurus is running and accessible.');
      } else {
        setDocumentationData(docusaurusData);
      }
    } catch (err) {
      setError('Failed to load documentation from Docusaurus');
      setDocumentationData([]);
    } finally {
      setLoading(false);
    }
  };

  const categories: { key: DocumentationCategory | 'all'; label: string; icon: React.ReactNode; color: any }[] = [
    { key: 'all', label: 'All', icon: <DescriptionIcon />, color: 'neutral' },
    { key: 'admin-settings', label: 'Admin Settings', icon: <SettingsIcon />, color: 'primary' },
    { key: 'architecture', label: 'Architecture', icon: <AccountTreeIcon />, color: 'success' },
    { key: 'development', label: 'Development', icon: <CodeIcon />, color: 'warning' },
    { key: 'migration', label: 'Migration', icon: <SwapHorizIcon />, color: 'danger' },
    { key: 'api', label: 'API Reference', icon: <ApiIcon />, color: 'info' },
    { key: 'agents', label: 'Agents', icon: <SmartToyIcon />, color: 'primary' },
    { key: 'features', label: 'Features', icon: <FeaturedPlayListIcon />, color: 'success' },
    { key: 'client-side', label: 'Client-Side', icon: <CodeIcon />, color: 'warning' },
    { key: 'aws', label: 'AWS', icon: <CloudIcon />, color: 'info' },
    { key: 'artifacts', label: 'Artifacts', icon: <ExtensionIcon />, color: 'primary' },
    { key: 'security', label: 'Security', icon: <SecurityIcon />, color: 'danger' },
    { key: 'databases', label: 'Databases', icon: <StorageIcon />, color: 'info' },
    { key: 'testing', label: 'Testing', icon: <BugReportIcon />, color: 'warning' },
    { key: 'onboarding', label: 'Onboarding', icon: <SchoolIcon />, color: 'success' },
    { key: 'files', label: 'Files', icon: <FolderIcon />, color: 'neutral' },
    { key: 'tags', label: 'Tags Search', icon: <LocalOfferIcon />, color: 'info' },
    { key: 'general', label: 'General', icon: <HelpIcon />, color: 'neutral' },
  ];

  // Filter documentation based on search and category
  const filteredDocs = useMemo(() => {
    let docs = documentationData;

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

  return (
    <Box sx={{ p: 3 }}>
      <Stack spacing={3}>
        {/* Search and Filters */}
        <Card sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} spacing={2}>
              <Box sx={{ flex: 1 }}>
                <SearchBar
                  searchTerm={searchTerm}
                  onSearchChange={setSearchTerm}
                  placeholder="Search documentation..."
                />
              </Box>
              <Button
                variant="outlined"
                color="neutral"
                size="sm"
                startDecorator={<RefreshIcon />}
                onClick={loadDocumentation}
                loading={loading}
                sx={{ width: { xs: '100%', sm: 'auto' } }}
              >
                Refresh
              </Button>
            </Stack>

            {/* Status Alert */}
            {error && (
              <Alert variant="soft" color="warning" size="sm">
                {error}
              </Alert>
            )}

            {!error && documentationData.length > 0 && (
              <Alert variant="soft" color="success" size="sm">
                📖 Showing {documentationData.length} docs from Docusaurus
              </Alert>
            )}

            {/* Category Filters */}
            <Box>
              <Typography level="body-sm" sx={{ mb: 1, fontWeight: 'medium' }}>
                Categories:
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ gap: 1 }}>
                {categories.map(category => (
                  <Chip
                    key={category.key}
                    variant={selectedCategory === category.key ? 'solid' : 'outlined'}
                    color={selectedCategory === category.key ? category.color : 'neutral'}
                    onClick={() => setSelectedCategory(category.key)}
                    startDecorator={category.icon}
                    size="sm"
                    sx={{ cursor: 'pointer' }}
                  >
                    {category.label}
                  </Chip>
                ))}
              </Stack>
            </Box>
          </Stack>
        </Card>

        <Divider />

        {/* Documentation Sections */}
        <Box>
          <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
            <Typography level="title-lg">📖 Documentation ({filteredDocs.length})</Typography>
            <ContextHelpButton helpId="admin/documentation" tooltipText="Documentation Help" />
            {searchTerm && (
              <Chip size="sm" color="primary" variant="soft">
                Search: {searchTerm}
              </Chip>
            )}
          </Stack>

          {loading ? (
            <Card sx={{ p: 3, textAlign: 'center' }}>
              <Stack spacing={2} alignItems="center">
                <CircularProgress size="md" />
                <Typography level="body-md" sx={{ color: 'text.secondary' }}>
                  Loading documentation...
                </Typography>
              </Stack>
            </Card>
          ) : filteredDocs.length === 0 ? (
            <Card sx={{ p: 3, textAlign: 'center' }}>
              <Typography level="body-md" sx={{ color: 'text.secondary' }}>
                {searchTerm
                  ? 'No documentation found matching your search.'
                  : 'No documentation available for this category.'}
              </Typography>
            </Card>
          ) : (
            <Grid container spacing={2}>
              {filteredDocs.map(doc => (
                <Grid key={doc.id} xs={12} md={6} lg={4}>
                  <DocSection doc={doc} />
                </Grid>
              ))}
            </Grid>
          )}
        </Box>
      </Stack>
    </Box>
  );
};

export default DocumentationTab;
