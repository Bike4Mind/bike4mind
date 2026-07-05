import { SvgIconComponent } from '@mui/icons-material';
import {
  Description as TextIcon,
  Image as ImageIcon,
  RemoveRedEye as VisionIcon,
  Casino as DiceIcon,
  Search as WebSearchIcon,
  Calculate as MathIcon,
  Code as CodeIcon,
  Person as HumanIcon,
  Speed as EasyIcon,
  Pending as MediumIcon,
  Warning as HardIcon,
} from '@mui/icons-material';

export enum TaskType {
  TEXT_GENERATION = 'text_generation',
  IMAGE_GENERATION = 'image_generation',
  VISION_REVIEW = 'vision_review',
  DICE_ROLL = 'dice_roll',
  WEB_SEARCH = 'web_search',
  MATH_SOLVER = 'math_solver',
  CODE_WRITING = 'code_writing',
  HUMAN_TASK = 'human_task',
}

export enum Difficulty {
  EASY = 'easy',
  MEDIUM = 'medium',
  HARD = 'hard',
}

export const TaskTypeIcons: Record<TaskType, SvgIconComponent> = {
  [TaskType.TEXT_GENERATION]: TextIcon,
  [TaskType.IMAGE_GENERATION]: ImageIcon,
  [TaskType.VISION_REVIEW]: VisionIcon,
  [TaskType.DICE_ROLL]: DiceIcon,
  [TaskType.WEB_SEARCH]: WebSearchIcon,
  [TaskType.MATH_SOLVER]: MathIcon,
  [TaskType.CODE_WRITING]: CodeIcon,
  [TaskType.HUMAN_TASK]: HumanIcon,
};

export const DifficultyIcons: Record<Difficulty, SvgIconComponent> = {
  [Difficulty.EASY]: EasyIcon,
  [Difficulty.MEDIUM]: MediumIcon,
  [Difficulty.HARD]: HardIcon,
};

export const getTaskTypeColor = (type: TaskType): 'primary' | 'success' | 'warning' | 'danger' | 'neutral' => {
  switch (type) {
    case TaskType.TEXT_GENERATION:
      return 'primary';
    case TaskType.IMAGE_GENERATION:
      return 'success';
    case TaskType.VISION_REVIEW:
      return 'warning';
    case TaskType.DICE_ROLL:
      return 'neutral';
    case TaskType.WEB_SEARCH:
      return 'primary';
    case TaskType.MATH_SOLVER:
      return 'warning';
    case TaskType.CODE_WRITING:
      return 'success';
    case TaskType.HUMAN_TASK:
      return 'danger';
  }
};

export const getDifficultyColor = (difficulty: Difficulty): 'success' | 'warning' | 'danger' => {
  switch (difficulty) {
    case Difficulty.EASY:
      return 'success';
    case Difficulty.MEDIUM:
      return 'warning';
    case Difficulty.HARD:
      return 'danger';
  }
};
