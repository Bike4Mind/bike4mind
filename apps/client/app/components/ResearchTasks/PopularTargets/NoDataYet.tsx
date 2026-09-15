import { useState } from 'react';
import { Box, Typography, Button } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import CategoryFormModal from './CategoryFormModal';
import ExportControls from './ExportControls';
import { purple, gray, cyan, blackAlpha } from '@client/app/utils/themes/colors';

const NoDataYet = () => {
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        gap: 4,
        position: 'relative',
      }}
    >
      <ExportControls showExport={false} />
      <Box
        sx={{
          textAlign: 'center',
          py: 6,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          opacity: 0.85,
        }}
      >
        <Box
          sx={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: `linear-gradient(135deg, ${purple[300]} 0%, ${gray[8]} 100%)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            mb: 2,
            boxShadow: `0 4px 24px ${blackAlpha[0][8]}`,
          }}
        >
          <AddIcon sx={{ fontSize: 36, color: purple[300] }} />
        </Box>
        <Typography level="h4" sx={{ fontWeight: 700, color: purple[300], mb: 1 }}>
          No Data Yet
        </Typography>
        <Typography level="body-md" color="neutral" sx={{ maxWidth: 340, mx: 'auto', mb: 1 }}>
          {`You haven't added any categories or companies yet.`}
          <br />
          Start by adding a category, or import your data using the template.
        </Typography>
      </Box>
      <Button
        variant="solid"
        color="primary"
        size="lg"
        startDecorator={<AddIcon />}
        sx={{
          background: `linear-gradient(135deg, ${purple[300]} 0%, ${cyan[400]} 100%)`,
          borderRadius: '12px',
          px: 2,
          py: 1,
          fontWeight: 700,
          fontSize: '1rem',
          boxShadow: `0 4px 16px ${blackAlpha[0][8]}`,
          transition: 'all 0.2s cubic-bezier(.4,2,.6,1)',
          '&:hover': {
            background: `linear-gradient(135deg, ${cyan[400]} 0%, ${purple[300]} 100%)`,
            transform: 'scale(1.04)',
          },
        }}
        onClick={() => setCategoryModalOpen(true)}
      >
        Add Category
      </Button>
      <CategoryFormModal
        open={categoryModalOpen}
        initialCategory={undefined}
        onClose={() => setCategoryModalOpen(false)}
      />
    </Box>
  );
};

export default NoDataYet;
