import { colorPalettes, shades } from '@client/app/constants/tools';
import { Casino } from '@mui/icons-material';
import { Box, Divider, Dropdown, IconButton, Input, Menu, MenuButton } from '@mui/joy';
import colors from '@mui/joy/colors';
import { blackAlpha } from '../../../utils/themes/colors';
import { forwardRef, useEffect, useState } from 'react';

interface ColorPickerProps {
  value?: string;
  onChange?: (color: string) => void;
}

const ColorPicker = forwardRef<HTMLInputElement, ColorPickerProps>(function ColorPickerComponent(
  { value = colors.blue[500], onChange },
  ref
) {
  const [selectedColor, setSelectedColor] = useState<string>(value);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSelectedColor(value);
  }, [value]);

  const handleColorChange = (color: string) => {
    setSelectedColor(color);
    onChange?.(color);
    setOpen(false);
  };

  const handleRandomColor = () => {
    const randomColor =
      '#' +
      Math.floor(Math.random() * 16777215)
        .toString(16)
        .padStart(6, '0');
    handleColorChange(randomColor);
  };

  return (
    <Input
      value={selectedColor}
      onChange={e => handleColorChange(e.target.value)}
      type="search"
      size="sm"
      placeholder="Type or select color"
      sx={{
        backgroundColor: 'fileBrowser.createTag.backgroundColor',
        borderColor: 'border.solid',
        borderRadius: '10px',
        color: 'text.primary',
      }}
      startDecorator={
        <Dropdown open={open} onOpenChange={(e, open) => setOpen(open)}>
          <MenuButton
            variant="outlined"
            sx={{
              minWidth: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              p: '0px',
              ml: '2px',
              '&:hover': {
                bgcolor: 'transparent',
              },
            }}
          >
            <Box
              sx={{
                width: '40px',
                height: '24px',
                borderRadius: '6px',
                backgroundColor: selectedColor,
              }}
            />
          </MenuButton>
          <Menu
            sx={{
              p: 2,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              maxHeight: '400px',
              overflowY: 'auto',
              zIndex: 9999,
            }}
          >
            {colorPalettes.map(palette => (
              <Box
                key={palette.key}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(8, 1fr)',
                  gap: 1,
                }}
              >
                {shades.map(shade => (
                  <Box
                    key={`${palette.key}-${shade}`}
                    onClick={() => handleColorChange(colors[palette.key][shade])}
                    sx={{
                      width: '24px',
                      height: '24px',
                      backgroundColor: colors[palette.key][shade],
                      border: colors[palette.key][shade] === selectedColor ? '3px solid' : '1px solid transparent',
                      borderColor: colors[palette.key][shade] === selectedColor ? 'primary.500' : 'transparent',
                      boxShadow:
                        colors[palette.key][shade] === selectedColor ? `0 0 0 2px ${blackAlpha[0][10]}` : 'none',
                      transform: colors[palette.key][shade] === selectedColor ? 'scale(1.1)' : 'scale(1)',
                      transition: 'all 0.2s ease',
                      cursor: 'pointer',
                      '&:hover': {
                        filter: 'brightness(0.9)',
                      },
                    }}
                  />
                ))}
              </Box>
            ))}
          </Menu>
        </Dropdown>
      }
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
            onClick={handleRandomColor}
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
          ref: ref,
          sx: {
            textAlign: 'center',
            fontSize: '14px',

            fontWeight: 400,
            width: '180px',
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
              top: '35%',
              left: '10%',
            },
          },
        },
      }}
    />
  );
});

export default ColorPicker;
