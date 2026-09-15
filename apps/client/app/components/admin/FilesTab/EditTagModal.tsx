import { api } from '@client/app/contexts/ApiContext';
import { IAppFileDocument } from '@bike4mind/common';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  ChipDelete,
  DialogTitle,
  FormControl,
  FormHelperText,
  Modal,
  ModalClose,
  ModalDialog,
  ModalOverflow,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uniq } from 'lodash';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { toast } from 'sonner';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

export const useEditAppFileTagModal = create<{
  targetFile: IAppFileDocument | null;
  setTargetFile: (fileId: IAppFileDocument | null) => void;
}>((set, get) => ({
  targetFile: null,
  setTargetFile: fileId => set({ targetFile: fileId }),
}));

export const GATED_TAG = 'Gated';

export const PRE_DEFINED_TAGS = ['Quarterly Reports', 'Annual Reports', 'Special Reports', GATED_TAG];

const EditTagModal = () => {
  const [targetFile, setTargetFile] = useEditAppFileTagModal(
    useShallow(state => [state.targetFile, state.setTargetFile])
  );
  const [tags, setTags] = useState<string[]>(['Reports', 'Quarterly']);
  const [value, setValue] = useState('');
  const [gated, setGated] = useState<boolean>(false);
  const [description, setDescription] = useState<string>('');
  const queryClient = useQueryClient();

  const updateTags = useMutation({
    mutationFn: async ({ tags, description }: { tags: string[]; description: string }) => {
      await api.patch<IAppFileDocument>('/api/app-files/update-tags', {
        id: targetFile?.id,
        tags,
        description,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['app-files'] });
    },
  });

  useEffect(() => {
    if (targetFile) {
      setTags(targetFile.tags ?? []);
      setGated(!!targetFile.tags?.some(tag => tag === GATED_TAG));
      setDescription(targetFile.description ?? '');
    }
  }, [targetFile]);

  const resetFields = useCallback(() => {
    setTargetFile(null);
    setGated(false);
    setDescription('');
  }, [setTargetFile]);

  const handleSave = useCallback(async () => {
    try {
      let _tags = [...tags, GATED_TAG];
      if (!gated) {
        _tags = tags.filter(tag => tag !== GATED_TAG);
      }

      await updateTags.mutateAsync({ tags: uniq(_tags), description });
      resetFields();
      toast.success('Report updated');
    } catch (error) {
      toast.error('Failed to update report');
    }
  }, [tags, description, gated, resetFields, updateTags]);

  const handleModalClose = (_: React.MouseEvent, reason: string) => {
    if (reason !== 'backdropClick') {
      resetFields();
    }
  };

  return (
    <Modal open={!!targetFile} onClose={handleModalClose}>
      <ModalOverflow>
        <ModalDialog minWidth="600px" maxWidth="400px">
          <ModalClose />

          <DialogTitle>Report Settings</DialogTitle>

          <Textarea
            startDecorator={
              <Box sx={{ display: 'flex', gap: '.25rem', flexWrap: 'wrap' }}>
                {tags
                  .filter(tag => ![GATED_TAG].includes(tag))
                  .map(tag => (
                    <Chip
                      key={tag}
                      endDecorator={<ChipDelete onClick={() => setTags(prev => prev.filter(t => t !== tag))} />}
                    >
                      {tag}
                    </Chip>
                  ))}
              </Box>
            }
            value={value}
            onChange={e => setValue(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                // Do not allow duplicates
                if (!tags.includes(value) && value) {
                  setTags(prev => [...prev, value]);
                  setValue('');
                }
                return;
              }

              if (e.key === 'Backspace' && value === '') {
                setTags(prev => prev.slice(0, prev.length - 1));
                return;
              }

              return;
            }}
          />

          <Box sx={{ mt: '1rem' }}>
            <Typography fontWeight={600}>Pre-defined tags:</Typography>
            <Box sx={{ display: 'flex', gap: '.25rem', flexWrap: 'wrap' }}>
              {PRE_DEFINED_TAGS.filter(tag => tag !== GATED_TAG && !tags.includes(tag)).map(tag => (
                <Chip key={tag} onClick={() => setTags(prev => [...prev, tag])}>
                  {tag}
                </Chip>
              ))}
            </Box>
          </Box>

          <Box sx={{ mt: '1rem' }}>
            <Typography
              fontWeight={600}
              component="label"
              endDecorator={
                <Switch checked={gated} onChange={event => setGated(event.target.checked)} sx={{ ml: 1 }} />
              }
            >
              Gated
            </Typography>
          </Box>

          <Box sx={{ mt: '1rem' }}>
            <FormControl>
              <Typography component={'label'} fontWeight={600}>
                Description
              </Typography>
              <Textarea
                placeholder="Enter a description"
                minRows={3}
                maxRows={10}
                onChange={e => setDescription(e.target.value)}
                value={description}
              />
              <FormHelperText>
                <InfoOutlinedIcon />
                <span>You can use Markdown to format the description.</span>
              </FormHelperText>

              <Accordion defaultExpanded>
                <AccordionSummary>Preview</AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <Box
                    sx={{
                      p: 2,
                      backgroundColor: 'hsla(204, 29%, 97%, 1)',
                      border: '1px solid hsla(206, 34%, 81%, 1)',
                    }}
                  >
                    <ReactMarkdown
                      components={{
                        h1: ({ children }) => <Typography level="h1">{children}</Typography>,
                        h2: ({ children }) => <Typography level="h2">{children}</Typography>,
                        h3: ({ children }) => <Typography level="h3">{children}</Typography>,
                        h4: ({ children }) => <Typography level="h4">{children}</Typography>,
                      }}
                    >
                      {description}
                    </ReactMarkdown>
                  </Box>
                </AccordionDetails>
              </Accordion>
            </FormControl>
          </Box>

          <Button sx={{ alignSelf: 'end' }} loading={updateTags.isPending} onClick={handleSave}>
            Save
          </Button>
        </ModalDialog>
      </ModalOverflow>
    </Modal>
  );
};

export default EditTagModal;
