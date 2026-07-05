import { SoraCostInput } from './SoraVideoCostCalculator';

export type VideoCostInput = SoraCostInput;

export interface VideoCostCalculator<T extends VideoCostInput> {
  getCost(input: T): number;
}
