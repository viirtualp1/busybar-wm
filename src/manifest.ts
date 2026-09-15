import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ProfileResolver } from 'busybar-kit/profile';

/**
 * What the supervisor knows about one app, and all it needs to know.
 *
 * The whole join between a manifest and a running app is `name`: it has to be
 * the `application_name` the app puts on its own draws, because that string is
 * the only identity the Bar's API carries. An app that draws under a name no
 * manifest claims still gets to the screen — it simply arrives unmanaged, at
 * rank zero, and nothing starts or stops it.
 */
export type AppManifest = {
  name: string;
  /**
   * Higher takes the screen. Worked out from the app's place in the manifest —
   * the first one listed is the highest — rather than written by hand.
   */
  rank: number;
  /** Left out for an app that is started by hand rather than supervised. */
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  autostart: boolean;
  restart: boolean;
};

export type WmManifest = {
  apps: AppManifest[];
};

const DEFAULT_RANK = 10;

/** Where `loadManifest` looks when nothing was named on the command line. */
export const DEFAULT_CONFIG_FILES = ['wm.config.json', 'wm.json'] as const;

export function loadManifest(
  path: string,
  cwd = process.cwd(),
  profile?: ProfileResolver,
): WmManifest {
  const file = isAbsolute(path) ? path : resolve(cwd, path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${file}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  // Paths in a manifest read as relative to the manifest, not to wherever the
  // daemon happened to be started from.
  return parseManifest(raw, resolve(file, '..'), profile);
}

export function parseManifest(
  raw: unknown,
  base: string,
  profile?: ProfileResolver,
): WmManifest {
  if (!isRecord(raw)) {
    throw new Error('manifest must be a JSON object');
  }
  if (!Array.isArray(raw.apps)) {
    throw new Error('manifest needs an "apps" array');
  }

  const apps = byPlace(
    raw.apps.map((entry, index) => parseApp(entry, index, base, profile)),
  );
  const seen = new Set<string>();
  for (const app of apps) {
    if (seen.has(app.name)) {
      throw new Error(`apps[].name "${app.name}" appears twice — names are identities`);
    }
    seen.add(app.name);
  }

  return { apps };
}

function parseApp(
  raw: unknown,
  index: number,
  base: string,
  profile?: ProfileResolver,
): AppManifest & { written?: number } {
  const at = `apps[${index}]`;
  if (!isRecord(raw)) {
    throw new Error(`${at} must be an object`);
  }

  const name = raw.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${at}.name must be the application_name the app draws with`);
  }

  // Only manifests written before order was the priority have one; see byPlace.
  const written = raw.rank;
  if (
    written !== undefined &&
    (typeof written !== 'number' || !Number.isFinite(written))
  ) {
    throw new Error(`${at}.rank must be a number — or better, left out`);
  }

  if (raw.command !== undefined && typeof raw.command !== 'string') {
    throw new Error(`${at}.command must be a string`);
  }
  if (raw.args !== undefined && !isStringArray(raw.args)) {
    throw new Error(`${at}.args must be an array of strings`);
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== 'string') {
    throw new Error(`${at}.cwd must be a path`);
  }
  if (raw.env !== undefined && !isStringRecord(raw.env)) {
    throw new Error(`${at}.env must be an object of strings`);
  }

  const named = raw.command?.trim() ? raw.command.trim() : undefined;
  // A profile supplies what the manifest left out: the app package installed
  // here, and the folder where that app keeps its own `.env`.
  const launch = resolveLaunch(named, name.trim(), profile);
  const command = launch?.command;
  const cwd =
    typeof raw.cwd === 'string' ? resolve(base, raw.cwd) : profile?.cwdFor(name.trim());

  if (raw.autostart === true && !command) {
    throw new Error(`${at}.autostart needs a command to start`);
  }

  return {
    name: name.trim(),
    rank: 0,
    ...(typeof written === 'number' ? { written } : {}),
    args: [...(launch?.prefix ?? []), ...(raw.args ?? [])],
    env: raw.env ?? {},
    // Supervising an app means starting it; a manifest that names a command
    // and says nothing else means "yes, run this".
    autostart: raw.autostart === undefined ? Boolean(command) : raw.autostart === true,
    restart: raw.restart === undefined ? true : raw.restart === true,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

/**
 * Priority is the order of the list: the first app listed takes the screen
 * over the second, and so on down. Ranks are worked out from that, ten apart.
 *
 * A manifest written before carries a number on each app instead. Those still
 * decide — sorted on first, so an old file means exactly what it always meant —
 * and an app such a file left without one sits where the old default put it.
 */
function byPlace(apps: (AppManifest & { written?: number })[]): AppManifest[] {
  const legacy = apps.some((app) => app.written !== undefined);
  const ordered = legacy
    ? [...apps].sort(
        (left, right) => (right.written ?? DEFAULT_RANK) - (left.written ?? DEFAULT_RANK),
      )
    : apps;

  return ordered.map((app, index) => {
    const placed: AppManifest & { written?: number } = {
      ...app,
      rank: (ordered.length - index) * 10,
    };
    delete placed.written;

    return placed;
  });
}

type Launch = { command: string; prefix: string[] };

/**
 * A manifest command wins, with one courtesy: a bare name is looked up in the
 * profile first, because busybar-dota written in a profile's manifest means the
 * package installed there, not whatever happens to be on PATH. Anything with a
 * path separator is taken literally, and so is a bare name the profile does not
 * provide.
 *
 * A package found in the profile is started as node on its bin script rather
 * than through the bin. On Windows that bin is a .cmd shim, a shim needs a
 * shell, and a shell in between makes the supervised pid cmd.exe: stopping it
 * does not reliably stop the app underneath, which then keeps its port. The
 * script is exactly what the shim runs. The shim is still used for a package
 * that does not say which script its bin is.
 */
function resolveLaunch(
  named: string | undefined,
  name: string,
  profile?: ProfileResolver,
): Launch | undefined {
  if (!profile) {
    return named ? { command: named, prefix: [] } : undefined;
  }

  if (named && /[\\/]/.test(named)) {
    return { command: named, prefix: [] };
  }

  const wanted = named ?? name;
  const entry = profile.entryFor(wanted);
  if (entry) {
    return { command: process.execPath, prefix: [entry] };
  }

  const bin = profile.binFor(wanted);
  if (bin) {
    return { command: bin, prefix: [] };
  }

  return named ? { command: named, prefix: [] } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
  );
}
