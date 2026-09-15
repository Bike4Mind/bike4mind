import { useState } from 'react';
import { Box, Chip, Sheet, Stack, Typography } from '@mui/joy';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { COOKBOOK_RECIPES, type CookbookRecipe } from './content/apiCookbookContent';

const DIFFICULTY_COLORS: Record<CookbookRecipe['difficulty'], 'success' | 'warning' | 'danger'> = {
  beginner: 'success',
  intermediate: 'warning',
  advanced: 'danger',
};

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
    bgcolor: 'neutral.100',
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
      borderColor: 'neutral.300',
      px: 1.5,
      py: 1,
      textAlign: 'left',
      fontSize: '0.875rem',
    },
    '& th': {
      bgcolor: 'neutral.100',
      fontWeight: 600,
    },
  },
  '& strong': {
    fontWeight: 600,
  },
};

const ApiCookbookTab = () => {
  const [selectedRecipe, setSelectedRecipe] = useState<CookbookRecipe | null>(null);

  if (selectedRecipe) {
    return (
      <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mb: 2,
            cursor: 'pointer',
            color: 'primary.500',
            '&:hover': { color: 'primary.700' },
          }}
          onClick={() => setSelectedRecipe(null)}
        >
          <ArrowBackIcon fontSize="small" />
          <Typography level="body-sm">Back to recipes</Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
          <Typography level="h3">{selectedRecipe.title}</Typography>
          <Chip size="sm" variant="soft" color={DIFFICULTY_COLORS[selectedRecipe.difficulty]}>
            {selectedRecipe.difficulty}
          </Chip>
        </Box>
        <Sheet variant="outlined" sx={{ p: 3, borderRadius: 'lg', ...markdownStyles }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedRecipe.content}</ReactMarkdown>
        </Sheet>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Typography level="h3" sx={{ mb: 1 }}>
        API Cookbook
      </Typography>
      <Typography level="body-sm" sx={{ mb: 3, color: 'neutral.500' }}>
        Practical recipes and patterns for working with the B4M API.
      </Typography>
      <Stack spacing={1.5}>
        {COOKBOOK_RECIPES.map(recipe => (
          <Sheet
            key={recipe.id}
            variant="outlined"
            sx={{
              p: 2,
              borderRadius: 'lg',
              cursor: 'pointer',
              '&:hover': { bgcolor: 'neutral.50', borderColor: 'primary.300' },
              transition: 'all 0.15s ease',
            }}
            onClick={() => setSelectedRecipe(recipe)}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Typography level="title-sm">{recipe.title}</Typography>
              <Chip size="sm" variant="soft" color={DIFFICULTY_COLORS[recipe.difficulty]}>
                {recipe.difficulty}
              </Chip>
            </Box>
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'neutral.500' }}>
              {recipe.description}
            </Typography>
          </Sheet>
        ))}
      </Stack>
    </Box>
  );
};

export default ApiCookbookTab;
