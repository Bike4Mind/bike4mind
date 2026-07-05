import React from 'react';
import { Chip } from '@mui/joy';
import { ModelInfo } from '@bike4mind/common';

interface PriceTierTagProps {
  model: ModelInfo;
}

export const PriceTierTag: React.FC<PriceTierTagProps> = ({ model }) => {
  const defaultKeys = Object.keys(model.pricing || {}).map(Number);
  const firstKey = defaultKeys.length > 0 ? defaultKeys[0] : 0;

  if (!model.pricing || !model.pricing[firstKey]) {
    return (
      <Chip color="neutral" size="sm">
        -
      </Chip>
    );
  }

  const avgCost = (model.pricing[firstKey].input + model.pricing[firstKey].output) / 2;

  if (model.type === 'text') {
    if (avgCost >= 5 / 1000000) {
      return (
        <Chip color="danger" size="sm">
          $$$
        </Chip>
      );
    } else if (avgCost >= 0.5 / 1000000) {
      return (
        <Chip color="warning" size="sm">
          $$
        </Chip>
      );
    }
    return (
      <Chip color="success" size="sm">
        $
      </Chip>
    );
  } else {
    if (avgCost >= 0.05) {
      return (
        <Chip color="danger" size="sm">
          $$$
        </Chip>
      );
    } else if (avgCost >= 0.02) {
      return (
        <Chip color="warning" size="sm">
          $$
        </Chip>
      );
    }
    return (
      <Chip color="success" size="sm">
        $
      </Chip>
    );
  }
};
