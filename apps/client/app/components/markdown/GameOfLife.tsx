import Button from '@mui/joy/Button';
import Grid from '@mui/joy/Grid';
import { Tooltip } from '@mui/joy';

import React, { useState, useEffect } from 'react';

type CellState = boolean;
type Grid = CellState[][];

interface GameOfLifeProps {
  width: number;
  height: number;
  cellSize: number;
  speed: number;
}

type Pattern = [number, number][];

const patterns = {
  glider: [
    [0, 1],
    [1, 2],
    [2, 0],
    [2, 1],
    [2, 2],
  ] as [number, number][],
  smallExploder: [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, 2],
    [2, 0],
    [2, 2],
    [3, 1],
  ] as [number, number][],
  gosperGliderGun: [
    [5, 1],
    [5, 2],
    [6, 1],
    [6, 2],
    [5, 11],
    [6, 11],
    [7, 11],
    [4, 12],
    [8, 12],
    [3, 13],
    [9, 13],
    [3, 14],
    [9, 14],
    [6, 15],
    [4, 16],
    [8, 16],
    [5, 17],
    [6, 17],
    [7, 17],
    [6, 18],
    [3, 21],
    [4, 21],
    [5, 21],
    [3, 22],
    [4, 22],
    [5, 22],
    [2, 23],
    [6, 23],
    [1, 25],
    [2, 25],
    [6, 25],
    [7, 25],
    [3, 35],
    [4, 35],
    [3, 36],
    [4, 36],
  ] as [number, number][],
  lightweightSpaceship: [
    [1, 0],
    [4, 0],
    [0, 1],
    [0, 2],
    [4, 2],
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ] as [number, number][],
  tumbler: [
    [0, 1],
    [1, 1],
    [3, 1],
    [4, 1],
    [0, 2],
    [1, 2],
    [3, 2],
    [4, 2],
    [1, 3],
    [3, 3],
    [1, 4],
    [2, 4],
    [3, 4],
    [1, 5],
    [2, 5],
    [3, 5],
  ] as [number, number][],
  pulsar: [
    [2, 0],
    [3, 0],
    [4, 0],
    [8, 0],
    [9, 0],
    [10, 0],
    [0, 2],
    [5, 2],
    [7, 2],
    [12, 2],
    [0, 3],
    [5, 3],
    [7, 3],
    [12, 3],
    [0, 4],
    [5, 4],
    [7, 4],
    [12, 4],
    [2, 5],
    [3, 5],
    [4, 5],
    [8, 5],
    [9, 5],
    [10, 5],
    [2, 7],
    [3, 7],
    [4, 7],
    [8, 7],
    [9, 7],
    [10, 7],
    [0, 8],
    [5, 8],
    [7, 8],
    [12, 8],
    [0, 9],
    [5, 9],
    [7, 9],
    [12, 9],
    [0, 10],
    [5, 10],
    [7, 10],
    [12, 10],
    [2, 12],
    [3, 12],
    [4, 12],
    [8, 12],
    [9, 12],
    [10, 12],
  ] as [number, number][],
};

const GameOfLife: React.FC<GameOfLifeProps> = ({ width, height, cellSize, speed }) => {
  const [grid, setGrid] = useState<Grid>(initializeGrid(width, height));

  const summonPattern = (patternName: keyof typeof patterns) => {
    setGrid(currentGrid => placePattern(patterns[patternName], currentGrid, width, height));
  };

  useEffect(() => {
    const interval = setInterval(() => {
      setGrid(prevGrid => nextGeneration(prevGrid));
    }, speed);

    // Clean up the interval on component unmount
    return () => clearInterval(interval);
  }, [speed]);

  // Inline styles
  const gameContainerStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `repeat(${width}, ${cellSize}px)`,
    gridGap: '1px',
  };

  const placePattern = (pattern: Pattern, grid: Grid, width: number, height: number): Grid => {
    const newGrid = [...grid].map(row => [...row]);
    const startX = Math.floor(Math.random() * (width - pattern[0][0]));
    const startY = Math.floor(Math.random() * (height - pattern[0][1]));

    pattern.forEach(([x, y]) => {
      try {
        if (startX + x < width && startY + y < height) {
          newGrid[startY + y][startX + x] = true;
        }
      } catch (e) {}
    });

    return newGrid;
  };

  const getCellStyle = (isAlive: boolean): React.CSSProperties => ({
    width: `${cellSize}px`,
    height: `${cellSize}px`,
    backgroundColor: isAlive ? 'white' : 'black',
    border: '1px solid #111',
  });

  return (
    <>
      {/* Buttons for patterns */}
      <Grid
        display={'flex'}
        width={'100%'}
        gap={1}
        alignContent={'center'}
        justifyContent={'space-between'}
        marginBottom={'5px'}
      >
        <Tooltip title="Glider">
          <Button onClick={() => summonPattern('glider')}>Glider</Button>
        </Tooltip>

        <Tooltip title="Small Exploder">
          <Button onClick={() => summonPattern('smallExploder')}>Exploder</Button>
        </Tooltip>
        <Tooltip title="Gosper Glider Gun">
          <Button onClick={() => summonPattern('gosperGliderGun')}>Gun</Button>
        </Tooltip>
        <Tooltip title="Lightweight Spaceship">
          <Button onClick={() => summonPattern('lightweightSpaceship')}>Ship</Button>
        </Tooltip>
        <Tooltip title="Tumbler">
          <Button onClick={() => summonPattern('tumbler')}>Tumber</Button>
        </Tooltip>
        <Tooltip title="Pulsar">
          <Button onClick={() => summonPattern('pulsar')}>Pulsar</Button>
        </Tooltip>
        {/* ... more buttons for other patterns */}
      </Grid>

      <div style={gameContainerStyle}>
        {grid.map((row, rowIndex) =>
          row.map((cell, cellIndex) => (
            <div
              key={`${rowIndex}-${cellIndex}`}
              style={getCellStyle(cell)}
            />
          ))
        )}
      </div>
    </>
  );
};

const placePattern = (pattern: Pattern, grid: Grid, width: number, height: number): Grid => {
  // This needs to ensure the entire pattern fits on the grid
  const startX = Math.floor(Math.random() * (width - Math.max(...pattern.map(([x]) => x))));
  const startY = Math.floor(Math.random() * (height - Math.max(...pattern.map(([, y]) => y))));

  // Copy the grid to avoid direct mutation
  const newGrid = grid.map(row => [...row]);

  // Place the pattern
  pattern.forEach(([x, y]) => {
    try {
      if (startX + x < width && startY + y < height) {
        newGrid[startY + y][startX + x] = true;
      }
    } catch (e) {}
  });

  return newGrid;
};

const initializeGrid = (width: number, height: number): Grid => {
  // Initialize a grid with false (dead cells)
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => false));

  // Randomly decide how many patterns to place (between 3 and 7)
  const numberOfPatterns = Math.floor(Math.random() * 5) + 3;

  const patternKeys: Array<keyof typeof patterns> = Object.keys(patterns) as Array<keyof typeof patterns>;

  for (let i = 0; i < numberOfPatterns; i++) {
    // Pick a random pattern
    const patternName = patternKeys[Math.floor(Math.random() * patternKeys.length)];
    const pattern = patterns[patternName];

    // Place the pattern on the grid
    const newGrid = placePattern(pattern, grid, width, height);
    Object.assign(grid, newGrid); // Update the grid with the new pattern
  }

  return grid;
};

const nextGeneration = (grid: Grid): Grid => {
  const nextGen = grid.map(row => [...row]); // Create a copy of the grid

  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const aliveNeighbors = countAliveNeighbors(grid, x, y);

      if (grid[y][x]) {
        // The cell is alive
        if (aliveNeighbors < 2 || aliveNeighbors > 3) {
          nextGen[y][x] = false; // Dies
        }
      } else {
        // The cell is dead
        if (aliveNeighbors === 3) {
          nextGen[y][x] = true; // Comes to life
        }
      }
    }
  }

  return nextGen;
};

const countAliveNeighbors = (grid: Grid, x: number, y: number): number => {
  let count = 0;

  // Check all the neighbors
  for (let yOffset = -1; yOffset <= 1; yOffset++) {
    for (let xOffset = -1; xOffset <= 1; xOffset++) {
      if (xOffset === 0 && yOffset === 0) continue; // Skip the current cell

      const checkX = x + xOffset;
      const checkY = y + yOffset;

      if (checkX >= 0 && checkX < grid[0].length && checkY >= 0 && checkY < grid.length) {
        count += grid[checkY][checkX] ? 1 : 0;
      }
    }
  }

  return count;
};

export default GameOfLife;
