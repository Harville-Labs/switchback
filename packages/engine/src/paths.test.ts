import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tildify } from './paths.ts';

test('paths under the home directory are shown from ~', () => {
  const home = join('/', 'home', 'me');
  expect(tildify(join(home, '.switchback', 'config.json'), home)).toBe(
    join('~', '.switchback', 'config.json'),
  );
  expect(tildify(join('/', 'home', 'meg', 'x'), home)).toBe(join('/', 'home', 'meg', 'x'));
  expect(tildify(home, home)).toBe('~');
});
