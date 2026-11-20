import { Box } from '@mui/joy';

interface SignupHoneypotProps {
  value: string;
  onChange: (value: string) => void;
}

// Positioned off-screen rather than display:none, which many bots skip when filling fields.
export default function SignupHoneypot({ value, onChange }: SignupHoneypotProps) {
  return (
    <Box
      aria-hidden="true"
      data-testid="signup-honeypot"
      sx={{ position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' }}
    >
      <input
        type="text"
        name="hp_ref_x"
        data-testid="signup-honeypot-input"
        tabIndex={-1}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </Box>
  );
}
