#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { errorMessage } from 'busybar-kit/errors';
import { loadConfig, loadEnvFile } from './config.js';
import { ConsoleLog, shouldColor } from './log/console.js';
import { DEFAULT_CONFIG_FILES, loadManifest } from './manifest.js';
import { ensureAppDirs, profileAt } from 'busybar-kit/profile';
import { Daemon } from './wm/daemon.js';

loadEnvFile();

const { manifestArg, profileArg } = parseArgs(process.argv.slice(2));
const { config, warnings } = loadConfig(process.env, manifestArg, profileArg);

const log = new ConsoleLog({
  color: shouldColor(process.stdout),
  verbose: config.log === 'verbose',
});

const profile = config.profile ? profileAt(config.profile) : undefined;
const explicit = Boolean(manifestArg) || Boolean(config.profile);
const path = resolveManifest(config.manifestPath, explicit);
const manifest = loadManifest(path, process.cwd(), profile);

log.reserve(['proxy', ...manifest.apps.map((app) => app.name)]);
log.heading('busybar-wm', [
  [profile ? 'profile' : 'manifest', profile ? profile.dir : path],
  ['apps', manifest.apps.map((app) => app.name).join(' › ') || 'none yet'],
]);

for (const warning of warnings) {
  log.warn(warning);
}

if (profile) {
  // Every app reads its `.env` from its working directory, so the folder has
  // to be there before the app starts looking.
  for (const dir of ensureAppDirs(
    profile,
    manifest.apps.map((app) => app.name),
  )) {
    log.info(`created ${dir} — put that app's .env there`);
  }
}

const daemon = new Daemon({
  config,
  manifest,
  logger: log,
  // The deck installs apps into the profile while this runs, and writes them
  // into the same file; reading it again is how they get started.
  reloadManifest: () => loadManifest(path, process.cwd(), profile),
});

let exiting = false;
async function shutdown(code: number): Promise<void> {
  if (exiting) {
    return;
  }
  exiting = true;
  await daemon.stop().catch(() => undefined);
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('unhandledRejection', (reason) => {
  log.warn(`unhandled rejection: ${errorMessage(reason)}`);
});

try {
  await daemon.start();
} catch (error) {
  log.error(errorMessage(error));
  await shutdown(1);
}

/**
 * `busybar-wm [manifest] [--profile <dir>]`. Small enough on purpose: anything
 * else worth setting lives in `.env`, where it can be written down once.
 */
function parseArgs(argv: string[]): { manifestArg?: string; profileArg?: string } {
  let manifestArg: string | undefined;
  let profileArg: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--profile' || arg === '-p') {
      profileArg = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--profile=')) {
      profileArg = arg.slice('--profile='.length);
    } else if (!arg.startsWith('-') && manifestArg === undefined) {
      manifestArg = arg;
    }
  }

  if (profileArg !== undefined && !profileArg.trim()) {
    console.error('--profile needs a directory');
    process.exit(1);
  }

  return {
    ...(manifestArg ? { manifestArg } : {}),
    ...(profileArg ? { profileArg } : {}),
  };
}

/** A named config must exist; an unnamed one may be either of the two defaults. */
function resolveManifest(preferred: string, explicit: boolean): string {
  if (explicit || existsSync(preferred)) {
    return preferred;
  }
  const found = DEFAULT_CONFIG_FILES.find((name) => existsSync(name));
  if (found) {
    return found;
  }

  console.error(
    `No ${DEFAULT_CONFIG_FILES.join(' or ')} here. Copy wm.config.example.json to start.`,
  );
  process.exit(1);
}
