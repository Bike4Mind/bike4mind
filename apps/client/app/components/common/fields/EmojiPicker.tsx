import { emojis } from '@client/app/constants/tools';
import { Casino } from '@mui/icons-material';
import { Box, Divider, IconButton, Input } from '@mui/joy';
import { gray, blackAlpha } from '../../../utils/themes/colors';
import { EmojiClickData, EmojiStyle } from 'emoji-picker-react';
import EmojiPickerReact from 'emoji-picker-react';
import { forwardRef, useRef, useState } from 'react';

interface EmojiPickerProps {
  value?: string;
  onChange?: (value: string) => void;
}

const EmojiPicker = forwardRef<HTMLInputElement, EmojiPickerProps>(function EmojiPickerComponent(
  { value = '', onChange },
  ref
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [showPicker, setShowPicker] = useState(false);

  const getRandomEmoji = () => {
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    onChange?.(randomEmoji);
  };

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    onChange?.(emojiData.emoji);
    setShowPicker(false);
  };

  return (
    <Box sx={{ position: 'relative' }}>
      <Input
        value={value}
        onChange={e => {
          const firstChar = Array.from(e.target.value)[1] || Array.from(e.target.value)[0] || '';
          onChange?.(firstChar);
        }}
        onClick={() => setShowPicker(!showPicker)}
        type="search"
        size="sm"
        placeholder="Type or select one emoji"
        sx={{
          backgroundColor: 'fileBrowser.createTag.backgroundColor',
          borderColor: 'border.solid',
          borderRadius: '10px',
          cursor: 'pointer',
        }}
        endDecorator={
          <Box
            alignItems="center"
            flexDirection="row"
            gap="4px"
            display="flex"
            sx={{ width: '32px', height: '20px', p: '0px', gap: '8px' }}
          >
            <Divider orientation="vertical" sx={{ height: '24px', bgcolor: 'border.solid', alignSelf: 'center' }} />
            <IconButton
              onClick={e => {
                e.stopPropagation();
                getRandomEmoji();
              }}
              variant="outlined"
              size="sm"
              sx={{
                width: '24px !important',
                height: '24px !important',
                minWidth: '24px !important',
                minHeight: '24px !important',
                borderRadius: '6px',
                p: '0px !important',
                my: '0px !important',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid',
                borderColor: 'border.solid',
              }}
            >
              <Casino sx={{ width: '18px', height: '18px', color: 'text.primary' }} />
            </IconButton>
          </Box>
        }
        slotProps={{
          input: {
            ref: inputRef,
            enterKeyHint: 'enter',
            'data-1p-ignore': 'true',
            inputMode: 'text',
            sx: {
              textAlign: 'center',
              width: '120px',
              height: '40px',
              borderRadius: '10px',
              '&::placeholder': {
                color: 'fileBrowser.createTag.secondaryText',
                fontSize: '8px',
                fontWeight: 400,
                lineHeight: 1,
                letterSpacing: '0.5px',
                textAlign: 'center',
                whiteSpace: 'pre-line',
                position: 'absolute',
                top: '25%',
              },
            },
          },
        }}
      />
      {showPicker && (
        <Box
          sx={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 1000,
            mt: 1,
            backgroundColor: 'white',
            borderRadius: '8px',
            boxShadow: `0 4px 6px -1px ${blackAlpha[0][10]}, 0 2px 4px -1px ${blackAlpha[0][6]}`,
            border: `1px solid ${gray[190]}`,
          }}
        >
          <EmojiPickerReact
            onEmojiClick={handleEmojiClick}
            searchPlaceholder="Search for emojis like rocket..."
            width={350}
            height={400}
            previewConfig={{
              showPreview: false,
            }}
            emojiStyle={EmojiStyle.NATIVE}
          />
        </Box>
      )}
    </Box>
  );
});

export default EmojiPicker;
