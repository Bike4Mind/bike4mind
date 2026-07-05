import { IProjectDocument } from '@bike4mind/common';
import { Box, Typography, Tooltip, IconButton } from '@mui/joy';
import { FC, memo, useRef, useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

interface ProjectSidenavItemProps {
  project: IProjectDocument;
  onClick?: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

const ProjectSidenavItem: FC<ProjectSidenavItemProps> = ({ project, onClick, isExpanded, onToggleExpand }) => {
  const navigate = useNavigate();
  const textRef = useRef<HTMLDivElement>(null);
  const [isTextTruncated, setIsTextTruncated] = useState(false);

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      navigate({ to: `/projects/${project.id}` });
    }
  };

  useEffect(() => {
    const checkTextTruncation = () => {
      if (textRef.current) {
        const element = textRef.current;
        setIsTextTruncated(element.scrollWidth > element.clientWidth);
      }
    };

    checkTextTruncation();
    window.addEventListener('resize', checkTextTruncation);
    return () => window.removeEventListener('resize', checkTextTruncation);
  }, [project.name]);

  return (
    <Box
      className="project-sidenav-item"
      onClick={handleClick}
      sx={theme => ({
        borderRadius: '8px',
        padding: onToggleExpand !== undefined ? '6px 12px 6px 4px' : '6px 12px',
        minHeight: '36px',
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        backgroundColor: 'transparent',
        '&:hover': {
          backgroundColor: theme.palette.notebooklist.hoverBg,
        },
        transition: 'background 0.2s',
      })}
    >
      {onToggleExpand !== undefined && (
        <IconButton
          data-testid="project-expand-btn"
          aria-label={isExpanded ? 'Collapse project' : 'Expand project'}
          aria-expanded={isExpanded}
          variant="plain"
          color="neutral"
          size="sm"
          onClick={e => {
            e.stopPropagation();
            onToggleExpand();
          }}
          sx={{
            minWidth: '20px',
            minHeight: '20px',
            width: '20px',
            height: '20px',
            p: 0,
            flexShrink: 0,
            transition: 'transform 0.15s',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            '--IconButton-size': '20px',
          }}
        >
          <ChevronRightIcon sx={{ fontSize: '16px' }} />
        </IconButton>
      )}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flex: 1,
          overflow: 'hidden',
          pl: onToggleExpand !== undefined ? '4px' : 0,
        }}
      >
        <Tooltip title="Project" placement="top">
          <Box
            sx={theme => ({
              width: '20px',
              height: '20px',
              borderRadius: '4px',
              backgroundColor: theme.palette.mode === 'dark' ? 'rgba(76, 175, 80, 0.1)' : 'rgba(76, 175, 80, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            })}
          >
            <HubOutlinedIcon
              sx={theme => ({
                fontSize: '14px',
                color: theme.palette.mode === 'dark' ? '#81C784' : '#388E3C',
              })}
            />
          </Box>
        </Tooltip>
        <Tooltip title={isTextTruncated ? project.name : ''} placement="bottom">
          <Typography
            ref={textRef}
            level="body-xs"
            sx={theme => ({
              color: theme.palette.neutral.softColor,
              fontWeight: 400,
              textAlign: 'left',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: 1,
            })}
            noWrap
          >
            {project.name}
          </Typography>
        </Tooltip>
      </Box>
    </Box>
  );
};

export default memo(ProjectSidenavItem);
