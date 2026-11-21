// Loaders for grim's recorded settings-kind output (0.15.1). Bundled into each
// test file, so `__dirname` is out/test, as in the other fixture readers.
import * as fs from 'fs';
import * as path from 'path';
import type { DetailsSources } from '../../webview/model';

export const recordedSettingsDir = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'test',
  'fixtures',
  'grim',
  '0.15.1-settings',
);

/** The recorded file `<name>.json`, unparsed. */
export const recordedSettingsRaw = (name: string): string =>
  fs.readFileSync(path.join(recordedSettingsDir, `${name}.json`), 'utf8');

/** The recorded file `<name>.json`, parsed. */
export const recordedSettings = <T = unknown>(name: string): T =>
  JSON.parse(recordedSettingsRaw(name)) as T;

/** A fetch report recorded from grim 0.16.1 (`0.16.1-mod/`), as a details source. */
export const recordedModFetch = (name: string): DetailsSources['fetch'] =>
  JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'src',
        'test',
        'fixtures',
        'grim',
        '0.16.1-mod',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as DetailsSources['fetch'];

/** Any file recorded from grim 0.16.1 (`0.16.1-mod/`), parsed. */
export const recordedMod = <T = unknown>(name: string): T =>
  JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'src',
        'test',
        'fixtures',
        'grim',
        '0.16.1-mod',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as T;
