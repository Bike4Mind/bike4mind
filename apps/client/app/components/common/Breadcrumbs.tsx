import { Breadcrumbs as MuiBreadcrumbs, Link, Typography, useTheme } from '@mui/joy';
import CircleIcon from '@mui/icons-material/Circle';
import { Link as RouterLink } from '@tanstack/react-router';

interface BreadcrumbsProps {
  items: {
    name: string;
    href?: string;
  }[];
}

const Breadcrumbs: React.FC<BreadcrumbsProps> = ({ items }) => {
  const theme = useTheme();
  const prevColor = theme.palette.text.primary50;
  const currentColor = theme.palette.text.primary;
  return (
    <MuiBreadcrumbs
      className="breadcrumbs"
      size="sm"
      separator={<CircleIcon sx={{ color: prevColor, fontSize: '4px' }} />}
      sx={{
        marginLeft: '12px',
        '--Breadcrumbs-gap': '4px',
      }}
    >
      {items.map((item, index) =>
        item.href ? (
          <Link
            className="breadcrumbs-link"
            fontWeight="sm"
            fontSize="sm"
            component={RouterLink}
            to={item.href}
            key={index}
            sx={{ color: prevColor }}
          >
            {item.name}
          </Link>
        ) : (
          <Typography
            className="breadcrumbs-current"
            variant="plain"
            fontSize="sm"
            fontWeight="sm"
            key={index}
            sx={{ color: currentColor }}
          >
            {item.name}
          </Typography>
        )
      )}
    </MuiBreadcrumbs>
  );
};

export default Breadcrumbs;
