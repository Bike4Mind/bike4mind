import { useState, useEffect, useCallback, startTransition } from 'react';
import { useRouter } from '@tanstack/react-router';

export interface NavigationState {
  isLoading: boolean;
  targetUrl: string | null;
  startTime: number | null;
  navigationId: string | null;
}

export interface UseNavigationLoadingReturn {
  isLoading: boolean;
  targetUrl: string | null;
  progress: number;
  startNavigation: (url: string) => void;
  completeNavigation: () => void;
  cancelNavigation: () => void;
}

export function useNavigationLoading(): UseNavigationLoadingReturn {
  const router = useRouter();
  const [state, setState] = useState<NavigationState>({
    isLoading: false,
    targetUrl: null,
    startTime: null,
    navigationId: null,
  });

  const startNavigation = useCallback((url: string) => {
    const navigationId = Date.now().toString();

    // Use React Transition for non-blocking updates
    startTransition(() => {
      setState({
        isLoading: true,
        targetUrl: url,
        startTime: Date.now(),
        navigationId,
      });
    });
  }, []);

  const completeNavigation = useCallback(() => {
    startTransition(() => {
      setState({
        isLoading: false,
        targetUrl: null,
        startTime: null,
        navigationId: null,
      });
    });
  }, []);

  const cancelNavigation = useCallback(() => {
    startTransition(() => {
      setState({
        isLoading: false,
        targetUrl: null,
        startTime: null,
        navigationId: null,
      });
    });
  }, []);

  useEffect(() => {
    // Subscribe to Tanstack Router state changes
    const unsubscribe = router.subscribe('onBeforeLoad', ({ pathChanged, toLocation }) => {
      if (pathChanged) {
        startNavigation(toLocation.href);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [router, startNavigation]);

  useEffect(() => {
    // Track when navigation completes
    const unsubscribe = router.subscribe('onLoad', () => {
      completeNavigation();
    });

    return () => {
      unsubscribe();
    };
  }, [router, completeNavigation]);

  // Also sync with router.state.isLoading for immediate updates
  useEffect(() => {
    if (!router.state.isLoading && state.isLoading) {
      completeNavigation();
    }
  }, [router.state.isLoading, state.isLoading, completeNavigation]);

  return {
    isLoading: state.isLoading || router.state.isLoading,
    targetUrl: state.targetUrl,
    progress: state.isLoading || router.state.isLoading ? 70 : 100, // Simplified progress
    startNavigation,
    completeNavigation,
    cancelNavigation,
  };
}
