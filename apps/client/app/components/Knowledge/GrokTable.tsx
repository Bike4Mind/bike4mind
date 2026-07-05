import React, { useState } from 'react';
import { Table, Sheet, Box, Button } from '@mui/joy';
import { parse } from 'papaparse';

interface GrokTableProps {
  csvContent: string;
}

const GrokTable: React.FC<GrokTableProps> = ({ csvContent }) => {
  const { data } = parse<string[]>(csvContent, { skipEmptyLines: true });
  const [page, setPage] = useState(1);
  const [rowsPerPage] = useState(20);

  if (data.length === 0) return <div>No data</div>;

  const headerRow = data[0];
  const bodyRows = data.slice(1);

  const handleChangePage = (newPage: number) => {
    setPage(newPage);
  };

  const paginatedRows = bodyRows.slice((page - 1) * rowsPerPage, page * rowsPerPage);

  const totalPages = Math.ceil(bodyRows.length / rowsPerPage);

  return (
    <Sheet variant="soft" sx={{ overflow: 'auto', pt: 1, borderRadius: 'sm' }}>
      <Table
        hoverRow
        stickyHeader
        stripe={'odd'}
        sx={{
          width: '100%',
          '& tr > *:first-of-type': {
            position: 'sticky',
            left: 0,
            boxShadow: '1px 0 0 0 var(--TableCell-borderColor)',
          },
        }}
      >
        <thead>
          <tr>
            {headerRow.map((header, index) => (
              <th key={index}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paginatedRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
      <Box sx={{ mt: 2, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <Button variant="outlined" onClick={() => handleChangePage(page - 1)} disabled={page === 1} sx={{ mr: 1 }}>
          Previous
        </Button>
        <span>
          {page} / {totalPages}
        </span>
        <Button
          variant="outlined"
          onClick={() => handleChangePage(page + 1)}
          disabled={page === totalPages}
          sx={{ ml: 1 }}
        >
          Next
        </Button>
      </Box>
    </Sheet>
  );
};

export default GrokTable;
