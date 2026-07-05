#!/usr/bin/env npx ts-node -r tsconfig-paths/register

import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

class GameDataJsonSplitter {
  private readonly options: {
    filepath: string;
    outputDir: string;
  };

  constructor(private readonly argv: string[]) {
    this.options = yargs(hideBin(this.argv))
      .options({
        filepath: {
          type: 'string',
          describe: 'Path to the gameData.json file',
          demandOption: true,
        },
        outputDir: {
          type: 'string',
          describe: 'Output directory',
          default: './gameDataJson',
        },
      })
      .strict()
      .strictOptions()
      .parseSync();
  }

  public async splitGameDataJson(gameData: { [key: string]: unknown }) {
    await mkdir(this.options.outputDir, { recursive: true });

    const ignoredKeys = ['_meta', 'arrays', 'idArrays'];

    for (const [key, value] of Object.entries(gameData)) {
      if (ignoredKeys.includes(key)) continue;

      const outputFilePath = path.resolve(this.options.outputDir, `${key}.json`);
      await writeFile(
        outputFilePath,
        JSON.stringify({
          [key]: value,
        }),
        'utf8'
      );
    }
  }

  public async run() {
    const filePath = path.resolve(this.options.filepath);
    const fileContent = await readFile(filePath, 'utf8');
    const gameData = JSON.parse(fileContent);

    await this.splitGameDataJson(gameData);

    return 0;
  }
}

new GameDataJsonSplitter(process.argv)
  .run()
  .then((r: number) => process.exit(r))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
