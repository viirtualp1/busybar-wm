#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { errorMessage } from 'busybar-kit/errors';
import { loadConfig, loadEnvFile } from './config.js';
import { DEFAULT_CONFIG_FILES, loadManifest } from './manifest.js';
import { ensureAppDirs, profileAt } from './profile.js';
import { Daemon } from './wm/daemon.js';

loadEnvFile();

const { manifestArg, profileArg } = parseArgs(process.argv.slice(2));
const { config, warnings } = loadConfig(process.env, manifestArg, profileArg);

console.log('busybar-wm');
for (const warning of warnings) {
  console.warn(warning);
}

const profile = config.profile ? profileAt(config.profile) : undefined;
if (profile) {
  console.log(`Profile: ${profile.dir}`);
}

const explicit = Boolean(manifestArg) || Boolean(config.profile);
const path = resolveManifest(config.manifestPath, explicit);
const manifest = loadManifest(path, process.cwd(), profile);

if (profile) {
  // Every app reads its `.env` from its working directory, so the folder has
  // to be there before the app starts looking.
  for (const dir of ensureAppDirs(
    profile,
    manifest.apps.map((app) => app.name),
  )) {
    console.log(`Created ${dir} — put that app's .env there`);
  }
}

console.log(
  `Apps: ${manifest.apps.map((app) => `${app.name}(${app.rank})`).join(', ') || 'none yet'}`,
);

const daemon = new Daemon({ config, manifest });

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
  console.warn(`Unhandled rejection: ${errorMessage(reason)}`);
});

try {
  await daemon.start();
} catch (error) {
  console.error(errorMessage(error));
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
