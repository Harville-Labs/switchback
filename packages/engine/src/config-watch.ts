/**
 * Config files, watched, so a running engine follows edits made outside it:
 * `switchback init` in a terminal, `switchback config edit`, or a text editor.
 * The shared daemon outlives any one client, so without this it keeps the
 * config it started with until every client has gone.
 */
import { type FSWatcher, statSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';

const stamp = (file: string) => {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'none';
  }
};

export class ConfigWatcher {
  private stamps: string[];
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `onChange` hears about each settled burst of writes to any of `files`. */
  constructor(
    private readonly files: string[],
    private readonly onChange: () => void,
    private readonly debounceMs = 200,
  ) {
    this.stamps = files.map(stamp);
    const byDir = new Map<string, string[]>();
    for (const f of files) byDir.set(dirname(f), [...(byDir.get(dirname(f)) ?? []), basename(f)]);
    for (const [dir, names] of byDir) {
      try {
        // The folder, not the file: editors often save by replacing it, and setup creates it.
        const w = watch(dir, (_event, name) => {
          if (name && !names.includes(String(name))) return;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.check(), this.debounceMs);
        });
        w.unref?.();
        this.watchers.push(w);
      } catch {
        // The folder doesn't exist yet; a setup run over the protocol still reloads.
      }
    }
  }

  private check(): void {
    const now = this.files.map(stamp);
    if (now.every((s, i) => s === this.stamps[i])) return;
    this.stamps = now;
    this.onChange();
  }

  close(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
