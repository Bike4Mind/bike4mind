import { useState } from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/joy';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { COOKBOOK_RECIPES, type CookbookRecipe } from './content/apiCookbookContent';
import { AdminPageHeader, DataTable, SectionCard, type DataColumn } from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

const DIFFICULTY_LABELS: Record<CookbookRecipe['difficulty'], string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

// Difficulty is a level, not a status, so it stays neutral (DESIGN_GUIDE section 2, "Status tones").
const DifficultyChip = ({ recipe }: { recipe: CookbookRecipe }) => (
  <Chip size="sm" variant="outlined" color="neutral" data-testid={`api-cookbook-${recipe.id}-difficulty`}>
    {DIFFICULTY_LABELS[recipe.difficulty]}
  </Chip>
);

const COLUMNS: readonly DataColumn<CookbookRecipe>[] = [
  {
    id: 'recipe',
    label: 'Recipe',
    render: recipe => (
      <Box sx={{ py: 1 }}>
        <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
          {recipe.title}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {recipe.description}
        </Typography>
      </Box>
    ),
  },
  { id: 'difficulty', label: 'Difficulty', width: '9rem', render: recipe => <DifficultyChip recipe={recipe} /> },
];

const markdownStyles = {
  '& h1': { fontSize: '1.6rem', fontWeight: 700, mt: 2, mb: 1.5 },
  '& h2': { fontSize: '1.25rem', fontWeight: 600, mt: 2, mb: 1 },
  '& h3': { fontSize: '1.05rem', fontWeight: 600, mt: 1.5, mb: 0.75 },
  '& p': { mb: 1.5, lineHeight: 1.7 },
  '& ul, & ol': { pl: 3, mb: 1.5 },
  '& li': { mb: 0.5 },
  '& code': {
    px: 0.75,
    py: 0.25,
    borderRadius: 'sm',
    fontSize: '0.85em',
    bgcolor: 'background.level1',
    color: 'text.primary',
  },
  '& pre': {
    p: 2,
    borderRadius: 'md',
    overflow: 'auto',
    bgcolor: 'neutral.900',
    color: 'neutral.50',
    mb: 2,
    '& code': {
      bgcolor: 'transparent',
      color: 'inherit',
      p: 0,
    },
  },
  '& table': {
    width: '100%',
    borderCollapse: 'collapse',
    mb: 2,
    '& th, & td': {
      border: '1px solid',
      borderColor: 'admin.border',
      px: 1.5,
      py: 1,
      textAlign: 'left',
      fontSize: '0.875rem',
    },
    '& th': {
      bgcolor: 'background.level1',
      color: 'text.primary',
      fontWeight: 600,
    },
  },
  '& strong': {
    fontWeight: 600,
  },
};

const ApiCookbookTab = () => {
  const [selectedRecipe, setSelectedRecipe] = useState<CookbookRecipe | null>(null);

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="admin-api-cookbook-tab">
      <AdminPageHeader
        title="API cookbook"
        count={selectedRecipe ? undefined : COOKBOOK_RECIPES.length}
        description="Copy-paste recipes for common API tasks. Open one to see its steps."
      />
      {selectedRecipe ? (
        <Stack gap={2}>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            startDecorator={<ArrowBackIcon />}
            onClick={() => setSelectedRecipe(null)}
            data-testid="api-cookbook-back-btn"
            sx={{ alignSelf: 'flex-start' }}
          >
            Back to recipes
          </Button>
          <SectionCard
            title={selectedRecipe.title}
            body="custom"
            action={<DifficultyChip recipe={selectedRecipe} />}
            data-testid="api-cookbook-recipe-detail"
          >
            <Box sx={{ p: 2, minWidth: 0, overflowX: 'auto', ...markdownStyles }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedRecipe.content}</ReactMarkdown>
            </Box>
          </SectionCard>
        </Stack>
      ) : (
        <DataTable
          rows={COOKBOOK_RECIPES}
          columns={COLUMNS}
          getRowId={recipe => recipe.id}
          label="API recipes"
          // Static rows never fail to load, so there is nothing to retry.
          onRetry={() => undefined}
          onRowActivate={setSelectedRecipe}
          rowTestId={recipe => `api-cookbook-recipe-${recipe.id}`}
          testId="api-cookbook-table"
          pagination={false}
          minWidth="32rem"
          maxHeight="none"
        />
      )}
    </Stack>
  );
};

export default ApiCookbookTab;
