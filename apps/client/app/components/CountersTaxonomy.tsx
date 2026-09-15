import React, { useState, useMemo } from 'react';
import { Table, Sheet, Typography, Input } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import countersData from './counters.json';

const CountersTaxonomy = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const filteredAndSortedData = useMemo(() => {
    return countersData
      .filter(item => item.counterName.toLowerCase().includes(searchTerm.toLowerCase()))
      .sort((a, b) => {
        const comparison = a.counterName.localeCompare(b.counterName);
        return sortOrder === 'asc' ? comparison : -comparison;
      });
  }, [searchTerm, sortOrder]);

  const toggleSortOrder = () => {
    setSortOrder(prevOrder => (prevOrder === 'asc' ? 'desc' : 'asc'));
  };

  return (
    <Sheet variant="outlined" sx={{ mt: 20, p: 5, borderRadius: 'md' }}>
      <Typography level="h2" sx={{ mb: 1 }}>
        Analytics Counters
      </Typography>
      <Input
        startDecorator={<SearchIcon />}
        placeholder="Search counters..."
        value={searchTerm}
        onChange={e => setSearchTerm(e.target.value)}
        sx={{ mb: 2, width: '100%' }}
      />
      <Table
        aria-label="Analytics Counters Table"
        stickyHeader
        hoverRow
        sx={{
          maxHeight: 400,
          overflow: 'auto',
          '--Table-headerUnderlineThickness': '1px',
        }}
      >
        <thead>
          <tr>
            <th style={{ width: '40%', cursor: 'pointer' }} onClick={toggleSortOrder}>
              Counter Name {sortOrder === 'asc' ? <ArrowUpwardIcon /> : <ArrowDownwardIcon />}
            </th>
            <th style={{ width: '40%' }}>File</th>
            <th style={{ width: '20%' }}>Line</th>
          </tr>
        </thead>
        <tbody>
          {filteredAndSortedData.map((item, index) => (
            <tr key={index}>
              <td>{item.counterName}</td>
              <td>
                <Typography noWrap title={item.file}>
                  {item.file}
                </Typography>
              </td>
              <td>{item.line}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Sheet>
  );
};

export default CountersTaxonomy;
