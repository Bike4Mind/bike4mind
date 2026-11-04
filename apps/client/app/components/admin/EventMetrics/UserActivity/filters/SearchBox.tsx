import React, { useState, useEffect, useMemo } from 'react';
import { FormControl, Input } from '@mui/joy';
import debounce from 'lodash/debounce';

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}

export const SearchBox: React.FC<SearchBoxProps> = ({ value, onChange, placeholder, disabled }) => {
  const [localValue, setLocalValue] = useState(value);

  const debouncedOnChange = useMemo(() => debounce((value: string) => onChange(value), 300), [onChange]);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    debouncedOnChange(newValue);
  };

  useEffect(() => {
    return () => {
      debouncedOnChange.cancel();
    };
  }, [debouncedOnChange]);

  return (
    <FormControl size="sm">
      <Input value={localValue} onChange={handleChange} placeholder={placeholder} disabled={disabled} />
    </FormControl>
  );
};
