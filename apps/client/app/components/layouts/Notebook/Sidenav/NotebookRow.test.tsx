import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import NotebookRow from './NotebookRow';
import type { CombinedItem } from './types';

vi.mock('@client/app/components/Agent/SidenavItem', () => ({
  default: ({ agent, onClick, isSelected }: any) => (
    <button data-testid="agent-item" data-selected={String(isSelected)} onClick={onClick}>
      {agent.id}
    </button>
  ),
}));

vi.mock('@client/app/components/Project/SidenavItem', () => ({
  default: ({ project, onClick }: any) => (
    <button data-testid="project-item" onClick={onClick}>
      {project.id}
    </button>
  ),
}));

vi.mock('@client/app/components/Session/SidenavItem', () => ({
  default: ({ session, onClick, onToggleSelection, selected, isChecked, leadingDecorator }: any) => (
    <div data-testid="session-item" data-selected={String(selected)} data-checked={String(isChecked)}>
      {leadingDecorator}
      <button data-testid="session-click" onClick={onClick}>
        {session.id}
      </button>
      <button data-testid="session-toggle" onClick={onToggleSelection}>
        toggle
      </button>
    </div>
  ),
}));

vi.mock('./NotebookRowBadges', async () => {
  const actual = await vi.importActual<object>('./NotebookRowBadges');
  return {
    ...actual,
    default: () => <span data-testid="row-badges" />,
  };
});

const baseProps = {
  isEditMode: false,
  isChecked: false,
  isShared: false,
  showMessageCount: true,
  onNavigate: vi.fn(),
  onNotebookClick: vi.fn(),
  onToggle: vi.fn(),
};

describe('NotebookRow', () => {
  it('renders an agent row and navigates to its dedicated screen on click', () => {
    const onNavigate = vi.fn();
    const agent = {
      id: 'agent-1',
      name: 'Agent',
      isAgent: true,
      lastUpdated: new Date(),
      firstCreated: new Date(),
      triggerWords: [],
    } as CombinedItem;
    render(<NotebookRow {...baseProps} onNavigate={onNavigate} item={agent} />);

    expect(screen.getByTestId('agent-item')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-item'));
    expect(onNavigate).toHaveBeenCalledWith('/agents/agent-1');
  });

  it('highlights the agent row only when it matches activeAgentId', () => {
    const agent = {
      id: 'agent-1',
      name: 'Agent',
      isAgent: true,
      lastUpdated: new Date(),
      firstCreated: new Date(),
      triggerWords: [],
    } as CombinedItem;
    const { rerender } = render(<NotebookRow {...baseProps} item={agent} activeAgentId="agent-2" />);
    expect(screen.getByTestId('agent-item')).toHaveAttribute('data-selected', 'false');

    rerender(<NotebookRow {...baseProps} item={agent} activeAgentId="agent-1" />);
    expect(screen.getByTestId('agent-item')).toHaveAttribute('data-selected', 'true');
  });

  it('renders a project row and navigates to its screen on click', () => {
    const onNavigate = vi.fn();
    const project = {
      id: 'project-1',
      name: 'Project',
      isProject: true,
      lastUpdated: new Date(),
      firstCreated: new Date(),
    } as CombinedItem;
    render(<NotebookRow {...baseProps} onNavigate={onNavigate} item={project} />);

    expect(screen.getByTestId('project-item')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('project-item'));
    expect(onNavigate).toHaveBeenCalledWith('/projects/project-1');
  });

  it('renders a session row, dispatching click and selection-toggle to the right callbacks', () => {
    const onNotebookClick = vi.fn();
    const onToggle = vi.fn();
    const session = { id: 'session-1', name: 'Session', imageCount: 0 } as CombinedItem;
    render(<NotebookRow {...baseProps} onNotebookClick={onNotebookClick} onToggle={onToggle} item={session} />);

    fireEvent.click(screen.getByTestId('session-click'));
    expect(onNotebookClick).toHaveBeenCalledWith(session);

    fireEvent.click(screen.getByTestId('session-toggle'));
    expect(onToggle).toHaveBeenCalledWith('session-1');
  });

  it('forces a session row unselected when suppressActive is set, otherwise defers to the default', () => {
    const session = { id: 'session-1', name: 'Session', imageCount: 0 } as CombinedItem;
    const { rerender } = render(<NotebookRow {...baseProps} item={session} suppressActive />);
    expect(screen.getByTestId('session-item')).toHaveAttribute('data-selected', 'false');

    rerender(<NotebookRow {...baseProps} item={session} suppressActive={false} />);
    expect(screen.getByTestId('session-item')).toHaveAttribute('data-selected', 'undefined');
  });

  it('only renders the badges decorator for a session that actually has badges to show', () => {
    const plain = { id: 'session-1', name: 'Session', imageCount: 0 } as CombinedItem;
    const { rerender } = render(<NotebookRow {...baseProps} item={plain} />);
    expect(screen.queryByTestId('row-badges')).toBeNull();

    const apiSession = { id: 'session-2', name: 'Session', imageCount: 0, origin: { channel: 'api' } } as CombinedItem;
    rerender(<NotebookRow {...baseProps} item={apiSession} />);
    expect(screen.getByTestId('row-badges')).toBeInTheDocument();
  });

  it('passes isChecked through for a session in edit mode', () => {
    const session = { id: 'session-1', name: 'Session', imageCount: 0 } as CombinedItem;
    render(<NotebookRow {...baseProps} item={session} isEditMode isChecked />);
    expect(screen.getByTestId('session-item')).toHaveAttribute('data-checked', 'true');
  });
});
