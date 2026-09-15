import React, { useEffect, useState, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { Box, Tabs, TabList, Tab, Typography, Sheet, IconButton, Tooltip } from '@mui/joy';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';

interface XLSXViewerProps {
  fileUrl: string;
}

interface CellStyle {
  backgroundColor?: string;
  color?: string;
  fontWeight?: string;
  textAlign?: 'left' | 'center' | 'right';
  border?: string;
}

type SheetData = Array<Array<string | number | boolean | null>>;

const XLSXViewer: React.FC<XLSXViewerProps> = ({ fileUrl }) => {
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [activeSheet, setActiveSheet] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const tabListRef = React.useRef<HTMLDivElement>(null);
  const [showScrollButtons, setShowScrollButtons] = useState({
    left: false,
    right: false,
  });

  useEffect(() => {
    const loadWorkbook = async () => {
      try {
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error('Failed to fetch file');
        const arrayBuffer = await response.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        setWorkbook(workbook);
        if (workbook.SheetNames.length > 0) {
          setActiveSheet(workbook.SheetNames[0]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load spreadsheet');
      }
    };

    loadWorkbook();
  }, [fileUrl]);

  useEffect(() => {
    const checkScroll = () => {
      if (tabListRef.current) {
        const { scrollLeft, scrollWidth, clientWidth } = tabListRef.current;
        setShowScrollButtons({
          left: scrollLeft > 0,
          right: scrollLeft < scrollWidth - clientWidth,
        });
      }
    };

    checkScroll();

    const tabList = tabListRef.current;
    if (tabList) {
      tabList.addEventListener('scroll', checkScroll);
      return () => tabList.removeEventListener('scroll', checkScroll);
    }
  }, [workbook]);

  const scrollTabList = (direction: 'left' | 'right') => {
    if (tabListRef.current) {
      const scrollAmount = direction === 'left' ? -200 : 200;
      tabListRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const activeSheetData = useMemo<SheetData | null>(() => {
    if (!workbook || !activeSheet) return null;
    const rawData = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[activeSheet], { header: 1 });
    return rawData as SheetData;
  }, [workbook, activeSheet]);

  const getCellStyle = (cell: string | number | boolean | null): CellStyle => {
    const style: CellStyle = {};

    if (typeof cell === 'number') {
      style.textAlign = 'right';
    } else if (typeof cell === 'boolean') {
      style.textAlign = 'center';
    }

    style.border = '1px solid var(--joy-palette-neutral-outlinedBorder)';

    return style;
  };

  const renderCell = (cell: string | number | boolean | null, rowIndex: number, colIndex: number) => {
    if (cell === undefined || cell === null) return null;

    const style = getCellStyle(cell);
    const cellValue = typeof cell === 'boolean' ? cell.toString() : cell;

    return (
      <Box
        key={`${rowIndex}-${colIndex}`}
        sx={{
          p: 1,
          minWidth: '100px',
          height: '32px',
          display: 'flex',
          alignItems: 'center',
          ...style,
        }}
      >
        <Typography level="body-sm" noWrap>
          {cellValue}
        </Typography>
      </Box>
    );
  };

  if (error) {
    return (
      <Box sx={{ p: 2, color: 'danger.500' }}>
        <Typography level="h4">Error loading spreadsheet</Typography>
        <Typography>{error}</Typography>
      </Box>
    );
  }

  if (!workbook || !activeSheetData) {
    return (
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <Typography>Loading spreadsheet...</Typography>
      </Box>
    );
  }

  const truncateTabName = (name: string) => {
    return name.length > 10 ? `${name.substring(0, 8)}...` : name;
  };

  return (
    <Box
      className="xlsx-viewer-container"
      sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <Box
        className="xlsx-viewer-tabs"
        sx={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider' }}
      >
        {showScrollButtons.left && (
          <IconButton onClick={() => scrollTabList('left')} size="sm" variant="plain" sx={{ flexShrink: 0 }}>
            <KeyboardArrowLeftIcon />
          </IconButton>
        )}

        <Tabs
          value={activeSheet}
          onChange={(_, newValue) => setActiveSheet(newValue as string)}
          sx={{ flex: 1, overflow: 'hidden' }}
        >
          <TabList
            ref={tabListRef}
            sx={{
              overflow: 'auto',
              scrollbarWidth: 'none', // Firefox
              '&::-webkit-scrollbar': { display: 'none' }, // Chrome, Safari, Edge
            }}
          >
            {workbook.SheetNames.map(name => (
              <Tooltip title={name} key={name}>
                <Tab value={name} sx={{ minWidth: '80px', maxWidth: '120px' }}>
                  <Typography level="body-xs" fontSize="0.65rem" sx={{ lineHeight: 1 }} noWrap>
                    {truncateTabName(name)}
                  </Typography>
                </Tab>
              </Tooltip>
            ))}
          </TabList>
        </Tabs>

        {showScrollButtons.right && (
          <IconButton onClick={() => scrollTabList('right')} size="sm" variant="plain" sx={{ flexShrink: 0 }}>
            <KeyboardArrowRightIcon />
          </IconButton>
        )}
      </Box>

      <Box className="xlsx-viewer-content" sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        <Sheet
          className="xlsx-viewer-sheet"
          variant="outlined"
          sx={{
            display: 'inline-block',
            borderRadius: 'sm',
            overflow: 'hidden',
          }}
        >
          <Box
            className="xlsx-viewer-grid"
            sx={{ display: 'grid', gridTemplateColumns: `repeat(${activeSheetData[0]?.length || 1}, auto)` }}
          >
            {activeSheetData.map((row, rowIndex) => row.map((cell, colIndex) => renderCell(cell, rowIndex, colIndex)))}
          </Box>
        </Sheet>
      </Box>
    </Box>
  );
};

export default XLSXViewer;
