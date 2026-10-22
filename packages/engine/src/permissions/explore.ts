/**
 * Shell commands that only look around the workspace: listing, reading,
 * searching, and read-only git. With `permissions.read: allow` they run without
 * asking, like the read, glob, and grep tools (ADR 0026). Anything that names a
 * place outside the workspace, writes, or could run another program isn't
 * exploring, and goes through the usual bash permission.
 */
import { statSync } from 'node:fs';
import { insideWorkspace, resolveFile } from '../tools/tool.ts';
import { parseCommand } from './bash-match.ts';

/** Programs that read and print. Ones with a flag that writes are checked in `WRITE_FLAGS`. */
const PROGRAMS = new Set([
  'ls',
  'pwd',
  'cd',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'du',
  'diff',
  'cut',
  'echo',
  'which',
  'basename',
  'dirname',
  'realpath',
  'find',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'tree',
  'sort',
  'uniq',
  'nl',
  'tac',
  'rev',
  'fold',
  'paste',
  'column',
  'comm',
  'tr',
  'readlink',
  'od',
  'hexdump',
  'cksum',
  'md5',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'shasum',
  'test',
  'true',
  'false',
]);

/** Programs that read the files under a directory they're given. */
const SEARCHES = new Set(['grep', 'egrep', 'fgrep', 'diff']);
/** Ones that search the current directory's tree when given no directory. */
const TREE_SEARCHES = new Set(['rg', 'git grep']);

export interface Exploration {
  /** The absolute paths the commands name, or their directory when they name none. */
  paths: string[];
  /**
   * Whether a command reads the contents of files under a directory, where a
   * read rule about one file inside can't be checked against the paths.
   */
  searchesDirectory: boolean;
}

/** Flags that turn a read into a write or another program (`find -exec`, `rg --pre`). */
const WRITE_FLAGS: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  rg: /^--pre(-glob)?(=|$)/,
  git: /^--(output|ext-diff)(=|$)/,
  // `-o` (alone or in a cluster such as `-uo`) names a file to write.
  sort: /^(-[a-zA-Z]*o|--output|--compress-program)/,
  tree: /^(-[a-zA-Z]*o|--output)/,
};

/** Read-only git subcommands, and the arguments allowed after the ones that can also write. */
const GIT: Record<string, ((args: string[]) => boolean) | true> = {
  status: true,
  diff: true,
  log: true,
  show: true,
  blame: true,
  grep: true,
  'ls-files': true,
  'rev-parse': true,
  describe: true,
  shortlog: true,
  // `git branch foo` creates a branch; only the listing forms are reads.
  branch: (a) => a.every((w) => /^(-a|-r|-v|-vv|--all|--list|--show-current)$/.test(w)),
  remote: (a) => a.every((w) => w === '-v'),
  stash: (a) => a[0] === 'list',
  tag: (a) => a.every((w) => /^(-l|--list)$/.test(w)),
};

/**
 * What an exploring command line reads, or undefined when it
 * isn't one: an unknown program, a wrapper (`sudo`, `xargs`), a variable,
 * substitution or output redirection, a writing flag, or a path outside `root`
 * (including one read through `<`).
 * Commands start in `root` and `cd` moves later ones, as the bash tool runs them.
 */
export function exploration(line: string, root: string): Exploration | undefined {
  const parsed = parseCommand(line);
  if (parsed.opaque || !parsed.commands.length || line.includes('$')) return undefined;
  let cwd = root;
  const paths: string[] = [];
  let searchesDirectory = false;
  for (const [i, command] of parsed.commands.entries()) {
    if (command !== parsed.bare[i]) return undefined;
    const [program = '', ...rest] = command.split(' ');
    const args =
      program === 'git'
        ? gitArgs(rest)
        : program === 'sed'
          ? sedFiles(rest)
          : program === 'uniq'
            ? uniqFiles(rest)
            : program === 'tr'
              ? [] // its operands are character sets, and it reads only its input
              : PROGRAMS.has(program)
                ? rest
                : undefined;
    if (!args) return undefined;
    const flags = WRITE_FLAGS[program];
    if (flags && rest.some((w) => flags.test(w))) return undefined;
    const reads: string[] = [];
    for (const word of [...args, ...(parsed.inputs[i] ?? [])]) {
      const value = word.startsWith('-') ? optionValue(word) : word;
      if (!value) continue;
      const file = resolveFile(cwd, value);
      if (!insideWorkspace(root, file)) return undefined;
      reads.push(file);
    }
    if (program === 'cd') {
      // `cd` alone goes home and `cd -` back; neither is a place in the workspace.
      if (args.length !== 1 || args[0] === '-' || !reads[0]) return undefined;
      cwd = reads[0];
    }
    const read = reads.length ? reads : [cwd];
    const name = program === 'git' ? `git ${rest.find((w) => w !== '--no-pager')}` : program;
    if (TREE_SEARCHES.has(name) || (SEARCHES.has(name) && read.some(isDirectory)))
      searchesDirectory = true;
    paths.push(...read);
  }
  return { paths, searchesDirectory };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false; // a missing path is the command's error, not a directory
  }
}

/** The arguments of a read-only git command, or undefined for any other. */
function gitArgs(rest: string[]): string[] | undefined {
  // Global options such as `-c` and `-C` can run programs or move the repository; only `--no-pager` passes.
  const words = rest[0] === '--no-pager' ? rest.slice(1) : rest;
  const [sub = '', ...args] = words;
  const rule = GIT[sub];
  if (!rule || (rule !== true && !rule(args))) return undefined;
  return args;
}

/** `uniq`'s arguments, or undefined when it names a second file, which it writes. */
function uniqFiles(rest: string[]): string[] | undefined {
  return rest.filter((w) => !w.startsWith('-')).length > 1 ? undefined : rest;
}

/** Flags that only change how sed reads and prints; `-i` writes and `-f` reads a script that might. */
const SED_FLAGS = /^(-n|-E|-r|-s|-u|-z|--quiet|--silent|--posix|--regexp-extended|--separate)$/;

const SED_ADDRESS = String.raw`(?:\d+|/(?:[^/\\\n]|\\.)*/I?)`;
const SED_TEXT = String.raw`(?:[^/\\\n]|\\.)*`;
/**
 * A sed script made only of commands that print: addresses, `p`, `d`, `q`,
 * `=`, hold-space moves, `y`, and `s` with `/` delimiters and no `w` or `e`
 * flag. Anything else (`w`, `r`, `e`, other delimiters) isn't checked and asks.
 */
const SED_SCRIPT = new RegExp(
  String.raw`^(?:${SED_ADDRESS}(?:,(?:${SED_ADDRESS}|[+~]\d+))?!?)?(?:[pdPDnNgGhHxl=]|[qQ]\d*|s/${SED_TEXT}/${SED_TEXT}/[gpiImM0-9]*|y/${SED_TEXT}/${SED_TEXT}/)$`,
);

/** The files a printing sed command reads, or undefined for one that may write or run things. */
function sedFiles(rest: string[]): string[] | undefined {
  const scripts: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? '';
    if (word === '-e') scripts.push(rest[++i] ?? '');
    else if (word.startsWith('-')) {
      if (!SED_FLAGS.test(word)) return undefined;
    } else if (!scripts.length && !files.length && !rest.includes('-e')) scripts.push(word);
    else files.push(word);
  }
  const commands = scripts.flatMap((s) => s.split(';')).map((c) => c.trim());
  if (!commands.length || !commands.every((c) => SED_SCRIPT.test(c))) return undefined;
  return files;
}

/** The value an option carries in the same word: `--file=x` or `-fx`; checked as a path. */
function optionValue(word: string): string | undefined {
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    return eq === -1 ? undefined : word.slice(eq + 1);
  }
  return word.slice(2) || undefined;
}
