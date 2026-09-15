import React from 'react';
import { Button } from '@mui/joy';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import AddBoxIcon from '@mui/icons-material/AddBox';
import AddBoxOutline from '@mui/icons-material/AddBoxOutlined';
import { brandAlpha } from '@client/app/utils/themes/colors';

interface NotebookActionCardProps {
  iconColor: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}

const NotebookActionCard: React.FC<NotebookActionCardProps> = ({ iconColor, title, subtitle, onClick }) => {
  return (
    <Button
      variant="outlined"
      color="neutral"
      onClick={onClick}
      sx={{
        flex: 1,
        minWidth: 0,
        width: '100%',
        height: { xs: 64, sm: 72 },
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'left',
        gap: { xs: 1, sm: 1.5 },
        boxShadow: `0 2px 8px 0 ${brandAlpha[700][3]}`,
        textAlign: 'left',
        pl: { xs: 1.5, sm: 2 },
        pr: { xs: 2, sm: 3 },
        backgroundColor: 'background.panel2',
        '&:hover': {
          backgroundColor: theme => theme.palette.session.cardHoverBackground,
        },
        border: '1px solid',
        borderColor: theme => theme.palette.session.cardBorder,
      }}
    >
      <Box
        sx={{
          width: { xs: 32, sm: 40 },
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          position: 'relative',
        }}
      >
        <AddBoxOutline sx={{ fontSize: { xs: 28, sm: 32 }, color: 'white', position: 'absolute' }} />
        <AddBoxIcon sx={{ fontSize: { xs: 28, sm: 32 }, color: iconColor, position: 'absolute' }} />
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: '4px', sm: '6px' }, minWidth: 0 }}>
        <Typography
          level="title-md"
          sx={{
            color: 'text.primary',
            fontWeight: 600,
            fontSize: { xs: '0.875rem', sm: '0.938rem' },
            lineHeight: 1.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </Typography>
        <Typography
          level="body-sm"
          sx={{
            color: 'text.primary50',
            fontSize: { xs: '0.75rem', sm: '0.813rem' },
            lineHeight: 1.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subtitle}
        </Typography>
      </Box>
    </Button>
  );
};

export default NotebookActionCard;
