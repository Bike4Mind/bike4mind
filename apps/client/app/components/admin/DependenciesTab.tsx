import { useState } from 'react';
import { Accordion, AccordionDetails, AccordionGroup, AccordionSummary, Box, Chip, Stack, Typography } from '@mui/joy';
import {
  PACKAGES,
  SHARED_DEPENDENCIES,
  DEPENDENCY_FLOW,
  DEPENDENCY_CATEGORIES,
  type SharedDependency,
} from './content/dependenciesData';
import { AdminPageHeader, DataTable, Fact, SectionCard, type DataColumn } from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

const SHARED_COLUMNS: readonly DataColumn<SharedDependency>[] = [
  {
    id: 'name',
    label: 'Package',
    render: dep => (
      <Typography level="body-sm" sx={{ fontFamily: 'code', color: 'admin.ink' }}>
        {dep.name}
      </Typography>
    ),
  },
  {
    id: 'version',
    label: 'Version',
    render: dep => (
      <Typography level="body-sm" sx={{ fontFamily: 'code', color: 'admin.inkMuted' }}>
        {dep.version}
      </Typography>
    ),
  },
  { id: 'usedBy', label: 'Used by (packages)', numeric: true, render: dep => dep.usedByCount.toLocaleString() },
  { id: 'category', label: 'Category', render: dep => dep.category },
];

const DependencyChips = ({ label, items, testId }: { label: string; items: readonly string[]; testId: string }) => (
  <Stack gap={1} data-testid={testId}>
    <Typography level="title-sm" component="h4" sx={{ color: 'admin.ink' }}>
      {label}
    </Typography>
    <Stack direction="row" flexWrap="wrap" gap={0.75}>
      {items.map(item => (
        <Chip key={item} size="sm" variant="outlined" color="neutral">
          {item}
        </Chip>
      ))}
    </Stack>
  </Stack>
);

const DependenciesTab = () => {
  const [expandedPackage, setExpandedPackage] = useState<string | null>(null);

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="admin-dependencies-tab">
      <AdminPageHeader
        title="Dependencies"
        description="Workspace packages, their key dependencies and the libraries they share."
      />

      <SectionCard title="Dependency categories" data-testid="dependencies-categories">
        {DEPENDENCY_CATEGORIES.map(category => (
          <Fact key={category.name} label={category.name}>
            {category.description}
          </Fact>
        ))}
      </SectionCard>

      <SectionCard title={`Packages (${PACKAGES.length})`} body="custom" data-testid="dependencies-packages">
        <AccordionGroup variant="plain" sx={{ borderRadius: 'lg' }}>
          {PACKAGES.map(pkg => (
            <Accordion
              key={pkg.name}
              expanded={expandedPackage === pkg.name}
              onChange={(_, expanded) => setExpandedPackage(expanded ? pkg.name : null)}
              data-testid={`dependencies-package-${pkg.name}`}
            >
              <AccordionSummary>
                <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5 }}>
                  <Typography level="title-sm" sx={{ fontFamily: 'code', color: 'admin.ink' }}>
                    {pkg.name}
                  </Typography>
                  <Chip size="sm" variant="soft" color="neutral" data-testid={`dependencies-package-${pkg.name}-type`}>
                    {pkg.type}
                  </Chip>
                  <Typography level="body-xs" sx={{ fontFamily: 'code', color: 'admin.inkMuted' }}>
                    v{pkg.version}
                  </Typography>
                  <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                    {pkg.description}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                <Stack gap={2} sx={{ pt: 1 }}>
                  {pkg.keyDependencies.length > 0 && (
                    <DependencyChips
                      label="Key dependencies"
                      items={pkg.keyDependencies.map(dep => `${dep.name} (${dep.version})`)}
                      testId={`dependencies-package-${pkg.name}-key`}
                    />
                  )}
                  {pkg.workspaceDependencies.length > 0 && (
                    <DependencyChips
                      label="Workspace dependencies"
                      items={pkg.workspaceDependencies}
                      testId={`dependencies-package-${pkg.name}-workspace`}
                    />
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>
          ))}
        </AccordionGroup>
      </SectionCard>

      <Stack gap={1.5}>
        <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
          Shared dependencies
        </Typography>
        <DataTable
          rows={SHARED_DEPENDENCIES}
          columns={SHARED_COLUMNS}
          getRowId={dep => dep.name}
          label="Shared dependencies"
          onRetry={() => undefined}
          rowTestId={dep => `dependencies-shared-${dep.name}`}
          testId="dependencies-shared-table"
          pagination={false}
          minWidth="36rem"
          maxHeight="none"
        />
      </Stack>

      <SectionCard title="Dependency flow" body="custom" data-testid="dependencies-flow">
        <Box
          component="pre"
          sx={{ m: 0, p: 2, overflowX: 'auto', fontFamily: 'code', typography: 'body-sm', color: 'admin.ink' }}
        >
          {DEPENDENCY_FLOW}
        </Box>
      </SectionCard>
    </Stack>
  );
};

export default DependenciesTab;
