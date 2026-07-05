import { useState, useMemo } from 'react';
import { Box, Button, Card, Container, Typography, Stack, Chip, CircularProgress } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { useNavigate } from '@tanstack/react-router';
import SiAtlassian, { defaultColor as SiAtlassianHex } from '@icons-pack/react-simple-icons/icons/SiAtlassian';
import { useFinalizeAtlassian } from '@client/app/hooks/data/mcpServers';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { APP_NAME } from '@client/config/general';

interface AtlassianResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}

interface GroupedSite {
  name: string;
  baseUrl: string;
  products: string[];
  // Use Confluence resource ID if available, otherwise first resource
  primaryResourceId: string;
  resources: AtlassianResource[];
}

const AtlassianSelectSitePage = () => {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const navigate = useNavigate();
  const [selectedSiteName, setSelectedSiteName] = useState<string | null>(null);

  const finalizeAtlassian = useFinalizeAtlassian();

  // Fetch resources from server instead of URL
  const {
    data: resourcesData,
    isLoading: isLoadingResources,
    error: resourcesError,
    refetch: refetchResources,
  } = useQuery({
    queryKey: ['atlassian-pending-resources'],
    queryFn: async () => {
      const { data } = await api.get('/api/mcp-servers/atlassian/pending-resources');
      return data.resources as AtlassianResource[];
    },
  });

  const resources = resourcesData ?? [];

  // Group resources by site name to avoid showing duplicate entries for Jira/Confluence
  const groupedSites = useMemo(() => {
    const siteMap = new Map<string, GroupedSite>();

    resources.forEach(resource => {
      const siteName = resource.name.toLowerCase();

      if (!siteMap.has(siteName)) {
        // Get base URL without /wiki suffix
        const baseUrl = resource.url.replace(/\/wiki$/, '');

        siteMap.set(siteName, {
          name: resource.name,
          baseUrl,
          products: [],
          primaryResourceId: resource.id,
          resources: [],
        });
      }

      const site = siteMap.get(siteName)!;
      site.resources.push(resource);

      // Extract products from scopes
      resource.scopes.forEach(scope => {
        if (scope.includes('jira') && !site.products.includes('Jira')) {
          site.products.push('Jira');
        }
        if (scope.includes('confluence') && !site.products.includes('Confluence')) {
          site.products.push('Confluence');
          // Prefer Confluence resource ID as primary (used for MCP server)
          site.primaryResourceId = resource.id;
        }
      });
    });

    return Array.from(siteMap.values());
  }, [resources]);

  const handleSelectSite = async (site: GroupedSite) => {
    setSelectedSiteName(site.name);
    await finalizeAtlassian.mutateAsync(site.primaryResourceId);
  };

  const handleCancel = async () => {
    try {
      await api.post('/api/mcp-servers/atlassian/cancel-selection');
    } catch (error) {
      console.error('Failed to cancel selection:', error);
    }
    navigate({ to: '/profile', search: { tab: '3' } as any });
  };

  // Show loading state while fetching resources
  if (isLoadingResources) {
    return (
      <Container
        maxWidth="md"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          justifyContent: 'center',
          alignItems: 'center',
          py: 4,
        }}
      >
        <Card
          variant="outlined"
          sx={{
            width: '100%',
            p: 4,
            boxShadow: 'md',
          }}
        >
          <Stack spacing={3} alignItems="center">
            <CircularProgress aria-label="Loading Atlassian sites" data-testid="atlassian-loading-spinner" />
            <Typography level="body-md" textAlign="center" color="neutral">
              Loading your Atlassian sites...
            </Typography>
          </Stack>
        </Card>
      </Container>
    );
  }

  // Show error state if fetching failed
  if (resourcesError) {
    return (
      <Container
        maxWidth="md"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          justifyContent: 'center',
          alignItems: 'center',
          py: 4,
        }}
      >
        <Card
          variant="outlined"
          sx={{
            width: '100%',
            p: 4,
            boxShadow: 'md',
          }}
        >
          <Stack spacing={3} alignItems="center">
            <Typography level="h2" textAlign="center" color="danger">
              Failed to Load Sites
            </Typography>
            <Typography level="body-md" textAlign="center" color="neutral">
              {resourcesError instanceof Error
                ? resourcesError.message
                : 'Failed to load Atlassian sites. Please try again.'}
            </Typography>
            <Stack direction="row" spacing={2}>
              <Button onClick={() => refetchResources()} data-testid="atlassian-retry-btn">
                Try Again
              </Button>
              <Button
                variant="outlined"
                onClick={() => navigate({ to: '/profile', search: { tab: '3' } as any })}
                data-testid="atlassian-return-btn"
              >
                Return to Profile
              </Button>
            </Stack>
          </Stack>
        </Card>
      </Container>
    );
  }

  // Show empty state if no resources
  if (!resources || resources.length === 0) {
    return (
      <Container
        maxWidth="md"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
          justifyContent: 'center',
          alignItems: 'center',
          py: 4,
        }}
      >
        <Card
          variant="outlined"
          sx={{
            width: '100%',
            p: 4,
            boxShadow: 'md',
          }}
        >
          <Stack spacing={3} alignItems="center">
            <Typography level="h2" textAlign="center" color="danger">
              No Sites Available
            </Typography>
            <Typography level="body-md" textAlign="center" color="neutral">
              No Atlassian sites were found. Please try connecting again.
            </Typography>
            <Button
              onClick={() => navigate({ to: '/profile', search: { tab: '3' } as any })}
              data-testid="atlassian-return-btn"
            >
              Return to Profile
            </Button>
          </Stack>
        </Card>
      </Container>
    );
  }

  return (
    <Container
      maxWidth="md"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        justifyContent: 'center',
        alignItems: 'center',
        py: 4,
      }}
    >
      <Card
        variant="outlined"
        sx={{
          width: '100%',
          p: 4,
          boxShadow: 'md',
        }}
      >
        <Stack spacing={3} alignItems="center">
          {/* Atlassian Logo */}
          <Box
            sx={{
              width: 80,
              height: 80,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '16px',
              background: mode === 'dark' ? '#0052CC' : '#0052CC',
              mb: 1,
            }}
          >
            <SiAtlassian color="#FFFFFF" size={48} />
          </Box>

          {/* Title */}
          <Typography level="h2" textAlign="center">
            Select Atlassian Site
          </Typography>

          {/* Description */}
          <Typography level="body-md" textAlign="center" color="neutral" sx={{ maxWidth: 500 }}>
            You have access to multiple Atlassian sites. Please select which site you would like to connect
            {APP_NAME ? ` with ${APP_NAME}` : ''}.
          </Typography>

          {/* Site Cards */}
          <Stack spacing={2} sx={{ width: '100%', mt: 2 }}>
            {groupedSites.map(site => {
              const isSelecting = selectedSiteName === site.name && finalizeAtlassian.isPending;

              return (
                <Card
                  key={site.name}
                  variant="outlined"
                  sx={{
                    p: 3,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    transition: 'all 0.2s ease',
                    '&:hover': {
                      borderColor: 'primary.500',
                      boxShadow: 'sm',
                    },
                  }}
                  data-testid={`atlassian-site-card-${site.name}`}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Box
                      sx={{
                        width: 48,
                        height: 48,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '8px',
                        bgcolor: mode === 'dark' ? 'rgba(0, 82, 204, 0.2)' : 'rgba(0, 82, 204, 0.1)',
                      }}
                    >
                      <SiAtlassian color={SiAtlassianHex} size={24} />
                    </Box>

                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography level="title-lg" sx={{ mb: 0.5 }}>
                        {site.name}
                      </Typography>
                      <Typography level="body-sm" color="neutral" sx={{ wordBreak: 'break-all' }}>
                        {site.baseUrl}
                      </Typography>
                    </Box>

                    <Button
                      onClick={() => handleSelectSite(site)}
                      loading={isSelecting}
                      disabled={finalizeAtlassian.isPending && selectedSiteName !== site.name}
                      data-testid={`atlassian-select-btn-${site.name}`}
                      sx={{ flexShrink: 0 }}
                    >
                      Select
                    </Button>
                  </Box>

                  {/* Product Badges */}
                  {site.products.length > 0 && (
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                      {site.products.map(product => (
                        <Chip
                          key={product}
                          size="sm"
                          variant="soft"
                          color="primary"
                          data-testid={`atlassian-product-badge-${product.toLowerCase()}`}
                        >
                          {product}
                        </Chip>
                      ))}
                    </Box>
                  )}
                </Card>
              );
            })}
          </Stack>

          {/* Error Message */}
          {finalizeAtlassian.isError && (
            <Typography level="body-sm" color="danger" textAlign="center" data-testid="atlassian-error-message">
              {finalizeAtlassian.error instanceof Error
                ? finalizeAtlassian.error.message
                : 'Failed to connect. Please try again.'}
            </Typography>
          )}

          {/* Cancel Button */}
          <Button
            variant="outlined"
            onClick={handleCancel}
            disabled={finalizeAtlassian.isPending}
            data-testid="atlassian-cancel-btn"
            sx={{ mt: 2 }}
          >
            Cancel
          </Button>
        </Stack>
      </Card>
    </Container>
  );
};

export default AtlassianSelectSitePage;
