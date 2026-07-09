import { IProjectDocument } from '@bike4mind/common';
import { Box, Typography, Tooltip, IconButton } from '@mui/joy';
import { FC, memo, useRef, useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

interface ProjectSidenavItemProps {
  project: IProjectDocument;
  onClick?: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  /** Highlights the row (blue bar + focused bg) when its dedicated project screen is open. */
  isSelected?: boolean;
}

const ProjectSidenavItem: FC<ProjectSidenavItemProps> = ({
  project,
  onClick,
  isExpanded,
  onToggleExpand,
  isSelected,
}) => {
  const navigate = useNavigate();
  const textRef = useRef<HTMLDivElement>(null);
  const [isTextTruncated, setIsTextTruncated] = useState(false);

  // A project with no member notebooks has nothing to expand into, so we drop the chevron
  // and show a muted "No notebooks" label in its place. Derived from sessionIds (always
  // present on the document) so we know it without the lazy per-project session fetch.
  const isEmpty = (project.sessionIds?.length ?? 0) === 0;

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
        position: 'relative',
        borderRadius: '8px',
        // Tighter right padding only when the 24px chevron occupies the right slot.
        padding: onToggleExpand !== undefined && !isEmpty ? '6px 6px 6px 12px' : '6px 12px',
        minHeight: '36px',
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        backgroundColor: isSelected ? theme.palette.notebooklist.focusedBackground : 'transparent',
        // Left active-indicator bar, matching the notebook row's selected state.
        '&::before': isSelected
          ? {
              content: '""',
              position: 'absolute',
              left: 0,
              top: '50%',
              transform: 'translateY(-50%)',
              width: '2px',
              height: '80%',
              // Match the project tag icon's green.
              backgroundColor: theme.palette.mode === 'dark' ? '#81C784' : '#388E3C',
              borderRadius: '1px',
            }
          : {},
        '&:hover': {
          backgroundColor: isSelected ? undefined : theme.palette.notebooklist.hoverBg,
        },
        transition: 'background 0.2s',
      })}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flex: 1,
          overflow: 'hidden',
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
                fontSize: '12px',
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
      {onToggleExpand !== undefined &&
        (isEmpty ? (
          <Typography
            level="body-xs"
            sx={{ color: 'text.tertiary', fontSize: '11px', flexShrink: 0, ml: '8px', whiteSpace: 'nowrap' }}
          >
            No notebooks
          </Typography>
        ) : (
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
              minWidth: '24px',
              minHeight: '24px',
              width: '24px',
              height: '24px',
              p: 0,
              ml: '4px',
              flexShrink: 0,
              '--IconButton-size': '24px',
              // Always visible (unlike the notebook three-dot, which is hover-gated), but reuse the
              // notebook button's color logic: icon at 50% by default, full on hover, no bg change.
              '& .MuiSvgIcon-root': {
                opacity: 0.5,
                transition: 'opacity 0.3s ease, transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                // Points down when collapsed, flips up when expanded.
                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              },
              '&:hover, &:focus-visible, &:active': {
                backgroundColor: 'transparent',
                '& .MuiSvgIcon-root': {
                  opacity: 1,
                },
              },
            }}
          >
            <KeyboardArrowDownIcon sx={{ fontSize: '16px' }} />
          </IconButton>
        ))}
    </Box>
  );
};

export default memo(ProjectSidenavItem);
