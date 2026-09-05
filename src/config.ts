import { loadBarConfig, type BarConfig } from 'busybar-kit/config';
import { DEFAULT_CONFIG_FILES } from './manifest.js';

export { loadEnvFile } from 'busybar-kit/config';

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 4111,
  minHoldMs: 3000,
  pinTimeoutMs: 60_000,
  tickMs: 1000,
  staleMs: 600_000,
  restartDelayMs: 2000,
  requestTimeoutMs: 10_000,
} as const;

const LIMITS = {
  port: { min: 1, max: 65_535 },
  minHoldMs: { min: 0, max: 60_000 },
  pinTimeoutMs: { min: 0, max: 3_600_000 },
  tickMs: { min: 100, max: 10_000 },
  staleMs: { min: 1000, max: 86_400_000 },
  restartDelayMs: { min: 200, max: 60_000 },
  requestTimeoutMs: { min: 1000, max: 30_000 },
} as const;

export type Config = {
  bar: BarConfig;
  manifestPath: string;
  host: string;
  port: number;
  minHoldMs: number;
  pinTimeoutMs: number;
  tickMs: number;
  staleMs: number;
  restartDelayMs: number;
  requestTimeoutMs: number;
  /** Listen to the Bar's own buttons for switching apps. */
  input: boolean;
  /** Let the knob switch apps too — off, because apps use it themselves. */
  knob: boolean;
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  manifestArg?: string,
): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  const { bar, env: reader } = loadBarConfig(env, warnings);
  const { read, number } = reader;

  return {
    warnings,
    config: {
      bar,
      manifestPath: manifestArg || read('WM_CONFIG') || DEFAULT_CONFIG_FILES[0],
      host: read('WM_HOST') || DEFAULTS.host,
      port: number('WM_PORT', DEFAULTS.port, LIMITS.port, true),
      minHoldMs: number('WM_MIN_HOLD_MS', DEFAULTS.minHoldMs, LIMITS.minHoldMs, true),
      pinTimeoutMs: number('WM_PIN_MS', DEFAULTS.pinTimeoutMs, LIMITS.pinTimeoutMs, true),
      tickMs: number('WM_TICK_MS', DEFAULTS.tickMs, LIMITS.tickMs, true),
      staleMs: number('WM_STALE_MS', DEFAULTS.staleMs, LIMITS.staleMs, true),
      restartDelayMs: number(
        'WM_RESTART_MS',
        DEFAULTS.restartDelayMs,
        LIMITS.restartDelayMs,
        true,
      ),
      requestTimeoutMs: number(
        'REQUEST_TIMEOUT_MS',
        DEFAULTS.requestTimeoutMs,
        LIMITS.requestTimeoutMs,
        true,
      ),
      input: read('WM_INPUT') !== '0',
      knob: read('WM_KNOB') === '1',
    },
  };
}
