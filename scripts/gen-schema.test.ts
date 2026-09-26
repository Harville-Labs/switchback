import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderSchema, SCHEMA_PATH } from './gen-schema.ts';

test('the shipped config schema is up to date (run `bun run schema`)', () => {
  // Compare structure, not bytes: Biome may reformat the file.
  expect(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))).toEqual(JSON.parse(renderSchema()));
});
