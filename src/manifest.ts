import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

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
  /** Higher takes the screen. Ties fall through to the app's own draw priority. */
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

export function loadManifest(path: string, cwd = process.cwd()): WmManifest {
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
  return parseManifest(raw, resolve(file, '..'));
}

export function parseManifest(raw: unknown, base: string): WmManifest {
  if (!isRecord(raw)) {
    throw new Error('manifest must be a JSON object');
  }
  if (!Array.isArray(raw.apps)) {
    throw new Error('manifest needs an "apps" array');
  }

  const apps = raw.apps.map((entry, index) => parseApp(entry, index, base));
  const seen = new Set<string>();
  for (const app of apps) {
    if (seen.has(app.name)) {
      throw new Error(`apps[].name "${app.name}" appears twice — names are identities`);
    }
    seen.add(app.name);
  }

  return { apps };
}

function parseApp(raw: unknown, index: number, base: string): AppManifest {
  const at = `apps[${index}]`;
  if (!isRecord(raw)) {
    throw new Error(`${at} must be an object`);
  }

  const name = raw.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${at}.name must be the application_name the app draws with`);
  }

  const rank = raw.rank ?? DEFAULT_RANK;
  if (typeof rank !== 'number' || !Number.isFinite(rank)) {
    throw new Error(`${at}.rank must be a number`);
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

  const command = raw.command?.trim() ? raw.command : undefined;
  const cwd = typeof raw.cwd === 'string' ? resolve(base, raw.cwd) : undefined;

  if (raw.autostart === true && !command) {
    throw new Error(`${at}.autostart needs a command to start`);
  }

  return {
    name: name.trim(),
    rank,
    args: raw.args ?? [],
    env: raw.env ?? {},
    // Supervising an app means starting it; a manifest that names a command
    // and says nothing else means "yes, run this".
    autostart: raw.autostart === undefined ? Boolean(command) : raw.autostart === true,
    restart: raw.restart === undefined ? true : raw.restart === true,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
  };
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
