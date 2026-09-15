import { useState } from 'react';

export default function useToggle(initialState: boolean = false): [boolean, (value?: boolean) => void] {
  const [state, setState] = useState(initialState);
  const toggle = (value?: boolean) => {
    if (typeof value === 'boolean') {
      setState(value);
    } else {
      setState(prevState => !prevState);
    }
  };
  return [state, toggle];
}
