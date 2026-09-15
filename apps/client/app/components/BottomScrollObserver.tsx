import { Box, CircularProgress } from '@mui/joy';
import { FC, useEffect, useRef } from 'react';

interface BottomObserverProps {
  isFetching: boolean;
  onBottomReached: () => void;
}

const BottomScrollObserver: FC<BottomObserverProps> = ({ isFetching, onBottomReached }) => {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const onBottomReachedRef = useRef(onBottomReached);

  // Keep the ref updated with the latest callback
  useEffect(() => {
    onBottomReachedRef.current = onBottomReached;
  }, [onBottomReached]);

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      entries => {
        const target = entries[0];
        if (target.isIntersecting) {
          onBottomReachedRef.current();
        }
      },
      {
        root: null,
        rootMargin: '200px',
        threshold: 0,
      }
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return (
    <Box
      ref={loadMoreRef}
      sx={{
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pb: '20px',
      }}
    >
      {isFetching && <CircularProgress size="sm" />}
    </Box>
  );
};

export default BottomScrollObserver;
