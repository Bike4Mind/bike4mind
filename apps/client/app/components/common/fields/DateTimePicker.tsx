import { Input } from '@mui/joy';
import dayjs from 'dayjs';
import { forwardRef } from 'react';

interface DateTimePickerProps {
  value?: Date;
  onChange?: (value: Date) => void;
}

const DateTimePicker = forwardRef<HTMLInputElement, DateTimePickerProps>((props, ref) => {
  const parsedDate = props.value ? dayjs(props.value).format('YYYY-MM-DDTHH:mm') : undefined;

  function handleChange(value: string) {
    const parsedDate = dayjs(value);
    props.onChange?.(parsedDate.toDate());
  }

  return (
    <Input ref={ref} value={parsedDate || ''} type="datetime-local" onChange={e => handleChange(e.target.value)} />
  );
});

DateTimePicker.displayName = 'DateTimePicker';

export default DateTimePicker;
