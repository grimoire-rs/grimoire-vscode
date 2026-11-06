// Loaders for grim's recorded settings-kind output (0.15.1). Bundled into each
// test file, so `__dirname` is out/test, as in the other fixture readers.
import * as fs from 'fs';
import * as path from 'path';

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
