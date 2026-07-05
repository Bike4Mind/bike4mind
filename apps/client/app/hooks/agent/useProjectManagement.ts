import { useState, useEffect, useCallback } from 'react';
import { IProject } from '@bike4mind/common';
import { api } from '../../contexts/ApiContext';
import { toast } from 'sonner';

/**
 * Project management hook
 */
export const useProjectManagement = () => {
  const [projects, setProjects] = useState<IProject[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  const fetchProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    try {
      const response = await api.get('/api/projects');
      const projectsData = response.data?.data || [];
      setProjects(projectsData);
      return projectsData;
    } catch (error) {
      console.error('Error fetching projects:', error);
      toast.error('Failed to load projects');
      return [];
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return {
    projects,
    isLoadingProjects,
    fetchProjects,
  };
};
