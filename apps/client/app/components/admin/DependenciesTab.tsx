import { useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, Chip, Sheet, Stack, Table, Typography } from '@mui/joy';
import {
  PACKAGES,
  SHARED_DEPENDENCIES,
  DEPENDENCY_FLOW,
  DEPENDENCY_CATEGORIES,
  type PackageInfo,
} from './content/dependenciesData';

const TYPE_COLORS: Record<PackageInfo['type'], 'primary' | 'success' | 'warning'> = {
  app: 'primary',
  package: 'success',
  core: 'warning',
};

const CATEGORY_CHIP_COLORS: Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  'UI Framework': 'primary',
  'AI/LLM': 'primary',
  'AWS Services': 'warning',
  Database: 'success',
  Authentication: 'danger',
  'File Processing': 'neutral',
  Testing: 'neutral',
  Communication: 'primary',
  Utilities: 'neutral',
};

const DependenciesTab = () => {
  const [expandedPackage, setExpandedPackage] = useState<string | null>(null);

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Typography level="h3" sx={{ mb: 3 }}>
        Dependencies
      </Typography>

      {/* Dependency Categories */}
      <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'lg', mb: 3 }}>
        <Typography level="title-md" sx={{ mb: 1.5 }}>
          Dependency Categories
        </Typography>
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {DEPENDENCY_CATEGORIES.map(cat => (
            <Chip key={cat.name} size="sm" variant="soft" color={CATEGORY_CHIP_COLORS[cat.name] || 'neutral'}>
              {cat.name}
            </Chip>
          ))}
        </Stack>
      </Sheet>

      {/* Package Cards */}
      <Typography level="title-md" sx={{ mb: 1.5 }}>
        Packages ({PACKAGES.length})
      </Typography>
      {PACKAGES.map(pkg => (
        <Accordion
          key={pkg.name}
          expanded={expandedPackage === pkg.name}
          onChange={(_, expanded) => setExpandedPackage(expanded ? pkg.name : null)}
          sx={{ mb: 1 }}
        >
          <AccordionSummary>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: '100%' }}>
              <Typography level="title-sm" sx={{ fontFamily: 'monospace' }}>
                {pkg.name}
              </Typography>
              <Chip size="sm" variant="soft" color={TYPE_COLORS[pkg.type]}>
                {pkg.type}
              </Chip>
              <Chip size="sm" variant="outlined">
                v{pkg.version}
              </Chip>
              <Typography level="body-xs" sx={{ color: 'neutral.500', ml: 'auto' }}>
                {pkg.description}
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails>
            <Box sx={{ pl: 1 }}>
              {pkg.keyDependencies.length > 0 && (
                <>
                  <Typography level="body-sm" sx={{ fontWeight: 600, mb: 1 }}>
                    Key Dependencies
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mb: 2 }}>
                    {pkg.keyDependencies.map(dep => (
                      <Chip
                        key={dep.name}
                        size="sm"
                        variant="soft"
                        color={CATEGORY_CHIP_COLORS[dep.category] || 'neutral'}
                      >
                        {dep.name} ({dep.version})
                      </Chip>
                    ))}
                  </Stack>
                </>
              )}
              {pkg.workspaceDependencies.length > 0 && (
                <>
                  <Typography level="body-sm" sx={{ fontWeight: 600, mb: 1 }}>
                    Workspace Dependencies
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" gap={0.75}>
                    {pkg.workspaceDependencies.map(dep => (
                      <Chip key={dep} size="sm" variant="outlined" color="primary">
                        {dep}
                      </Chip>
                    ))}
                  </Stack>
                </>
              )}
            </Box>
          </AccordionDetails>
        </Accordion>
      ))}

      {/* Shared Dependencies Table */}
      <Typography level="title-md" sx={{ mt: 3, mb: 1.5 }}>
        Shared Dependencies
      </Typography>
      <Sheet variant="outlined" sx={{ borderRadius: 'lg', overflow: 'auto', mb: 3 }}>
        <Table stripe="odd" size="sm">
          <thead>
            <tr>
              <th>Package</th>
              <th>Version</th>
              <th>Used By</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>
            {SHARED_DEPENDENCIES.map(dep => (
              <tr key={dep.name}>
                <td>
                  <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
                    {dep.name}
                  </Typography>
                </td>
                <td>{dep.version}</td>
                <td>{dep.usedByCount} packages</td>
                <td>
                  <Chip size="sm" variant="soft" color={CATEGORY_CHIP_COLORS[dep.category] || 'neutral'}>
                    {dep.category}
                  </Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Sheet>

      {/* Dependency Flow Diagram */}
      <Typography level="title-md" sx={{ mb: 1.5 }}>
        Dependency Flow
      </Typography>
      <Sheet
        variant="outlined"
        sx={{
          p: 2,
          borderRadius: 'lg',
          bgcolor: 'neutral.900',
          color: 'neutral.50',
          fontFamily: 'monospace',
          fontSize: '0.85rem',
          whiteSpace: 'pre',
          overflow: 'auto',
        }}
      >
        {DEPENDENCY_FLOW}
      </Sheet>
    </Box>
  );
};

export default DependenciesTab;
