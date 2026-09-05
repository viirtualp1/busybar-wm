#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { errorMessage } from 'busybar-kit/errors';
import { loadConfig, loadEnvFile } from './config.js';
import { DEFAULT_CONFIG_FILES, loadManifest } from './manifest.js';
import { Daemon } from './wm/daemon.js';

loadEnvFile();

const [manifestArg] = process.argv.slice(2);
const { config, warnings } = loadConfig(process.env, manifestArg);

console.log('busybar-wm');
for (const warning of warnings) {
  console.warn(warning);
}

const path = resolveManifest(config.manifestPath, Boolean(manifestArg));
const manifest = loadManifest(path);
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
