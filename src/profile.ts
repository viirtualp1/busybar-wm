import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A profile is one directory that holds a whole BUSY Bar setup: the manifest,
 * the apps themselves as installed packages, and a folder per app for its own
 * `.env` and data files.
 *
 * ```
 * ~/.busybar/
 *   wm.config.json
 *   node_modules/          the app packages, production dependencies only
 *   mydota/.env
 *   dota/.env  dota/schedule.json
 * ```
 *
 * Every app already reads its `.env` from its working directory, so pointing
 * each one at its own folder here means a packaged app finds its settings in
 * exactly the place a checked-out one always did — no change inside the apps.
 */
export type ProfileResolver = {
  /** The directory itself. */
  dir: string;
  /** Where an app keeps its `.env` and data files. */
  cwdFor: (name: string) => string;
  /** The bin an app package installed into this profile, if it is there. */
  binFor: (name: string) => string | undefined;
};

export type ProfileOptions = {
  /** Injected by the tests, which have no profile on disk. */
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
};

export function profileAt(dir: string, options: ProfileOptions = {}): ProfileResolver {
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  // npm writes a `.cmd` shim on Windows; the supervisor already knows to run
  // those through a shell, which is why the extension is kept here.
  const suffix = platform === 'win32' ? '.cmd' : '';

  return {
    dir,
    cwdFor: (name) => join(dir, name),
    binFor: (name) => {
      for (const candidate of binNames(name)) {
        const bin = join(dir, 'node_modules', '.bin', `${candidate}${suffix}`);
        if (exists(bin)) {
          return bin;
        }
      }

      return undefined;
    },
  };
}

/**
 * An app's manifest name is its `application_name` — `mydota`, `flights` — but
 * it ships as `busybar-mydota` and installs a bin by that name. Trying both is
 * what lets a manifest entry be nothing more than the name on its own draws.
 */
function binNames(name: string): string[] {
  return name.startsWith('busybar-') ? [name] : [name, `busybar-${name}`];
}

/**
 * Makes sure every app has somewhere to keep its `.env`. Creating the folder
 * up front is what lets a fresh profile be filled in by hand without having to
 * guess the layout first.
 */
export function ensureAppDirs(profile: ProfileResolver, names: readonly string[]) {
  const created: string[] = [];
  for (const name of names) {
    const dir = profile.cwdFor(name);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  return created;
}
