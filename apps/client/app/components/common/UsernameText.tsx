import { useGetUser } from '@client/app/hooks/data/user';
import { CircularProgress } from '@mui/joy';
import React, { FC, useEffect, useState } from 'react';

interface IProps {
  id: string;
  setUserName?: React.Dispatch<React.SetStateAction<string | null>>;
  postfix?: string;
  onSet?: (name: string) => void;
  parent?: React.ElementType;
  useEmail?: boolean;
}

const UsernameText: FC<IProps> = ({ id, setUserName, onSet, postfix, parent: Parent, useEmail = false }) => {
  const [name, setName] = useState<string | null>(null);
  const query = useGetUser(id);

  useEffect(() => {
    if (!query?.data) return;

    const userIdentifier = useEmail ? query.data.email : query.data.username;
    if (!userIdentifier) return;

    if (setUserName) setUserName(userIdentifier);
    const fullName = userIdentifier + (postfix ?? '');
    if (onSet) onSet(fullName);
    setName(fullName);
  }, [query.data, setUserName, onSet, postfix, useEmail]);

  const innerComponent = (
    <>
      {query.isFetching && !name ? (
        <CircularProgress
          className="username-loading-indicator"
          sx={{
            ml: '5px',
            '--CircularProgress-size': '14px',
            '--CircularProgress-trackThickness': '2px',
            '--CircularProgress-progressThickness': '2px',
          }}
        />
      ) : (
        name
      )}
    </>
  );

  return Parent ? <Parent>{innerComponent}</Parent> : innerComponent;
};

export default UsernameText;
