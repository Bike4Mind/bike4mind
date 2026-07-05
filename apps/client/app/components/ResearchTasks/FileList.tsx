import { IResearchDataWithFiles } from '@bike4mind/common';
import { Box, Card, CardContent, Chip, Input, Stack, Typography } from '@mui/joy';
import { InsertDriveFile } from '@mui/icons-material';
import { FC, useState, useTransition, useMemo } from 'react';
import { greenAlpha } from '../../utils/themes/colors';
import ResearchTaskFile from './File';

const ResearchTaskFileList: FC<{
  researchData: IResearchDataWithFiles[];
  onView: (fabFileId: string) => void;
}> = ({ researchData, onView }) => {
  const [search, setSearch] = useState('');
  const [isPending, startTransition] = useTransition();

  const filteredData = useMemo(() => {
    return researchData.filter(data => data.fabFile?.fileName.toLowerCase().includes(search.toLowerCase()));
  }, [researchData, search]);

  const handleSearchChange = (value: string) => {
    startTransition(() => {
      setSearch(value);
    });
  };

  return (
    <>
      <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.surface' }}>
        <Typography level="title-sm" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <InsertDriveFile sx={{ fontSize: 18, color: 'success.500' }} />
          Research Files
          <Chip variant="soft" color="success" size="sm">
            {researchData.length || 0} files
          </Chip>
        </Typography>
        <Typography level="body-sm" sx={{ color: 'neutral.600' }}>
          Generated research data and analysis files
        </Typography>
        <Box>
          <Input
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search files..."
            sx={{
              opacity: isPending ? 0.7 : 1,
              transition: 'opacity 0.2s ease',
            }}
          />
        </Box>
      </Box>

      <Box sx={{ height: 'calc(100% - 80px)', overflowY: 'auto', p: 2 }}>
        {!researchData || researchData.length === 0 ? (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'neutral.500',
            }}
          >
            <InsertDriveFile sx={{ fontSize: 48, mb: 2, opacity: 0.5 }} />
            <Typography level="title-sm" sx={{ mb: 1 }}>
              No Files Generated
            </Typography>
            <Typography level="body-sm" textAlign="center">
              No research data files have been generated yet
            </Typography>
          </Box>
        ) : (
          <Stack spacing={2}>
            {filteredData.map((file, index) => (
              <Card
                key={index}
                variant="outlined"
                sx={{
                  transition: 'all 0.2s ease',
                  opacity: isPending ? 0.8 : 1,
                  '&:hover': {
                    borderColor: 'success.300',
                    boxShadow: `0 2px 12px ${greenAlpha[500][15]}`,
                    transform: 'translateY(-1px)',
                  },
                }}
              >
                <CardContent>
                  <ResearchTaskFile researchData={file} onView={() => onView(file.fabFileId)} />
                </CardContent>
              </Card>
            ))}
          </Stack>
        )}
      </Box>
    </>
  );
};

export default ResearchTaskFileList;
