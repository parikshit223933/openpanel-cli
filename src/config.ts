import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

export const DEFAULT_INSTANCE = 'https://dashboard.openpanel.dev';

export interface AuthState {
  sessionToken: string;
  /** ISO timestamp; may be undefined if the server didn't expose an expiry. */
  expiresAt?: string;
  email?: string;
}

export interface CliConfig {
  /** Base URL of the OpenPanel instance, e.g. https://dashboard.openpanel.dev */
  instance?: string;
  auth?: AuthState;
}

const CONFIG_DIR = join(homedir(), '.config', 'openpanel-cli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): CliConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: CliConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  // Re-assert perms in case the file already existed with looser bits.
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

/** Resolve the instance base URL: env > config > default. */
export function getInstance(): string {
  const fromEnv = process.env.OPENPANEL_INSTANCE?.trim();
  if (fromEnv) return stripTrailingSlash(fromEnv);
  const cfg = loadConfig();
  return stripTrailingSlash(cfg.instance ?? DEFAULT_INSTANCE);
}

/** Full tRPC base URL, e.g. https://host/api/trpc (overridable via OPENPANEL_TRPC_URL). */
export function getTrpcUrl(): string {
  const override = process.env.OPENPANEL_TRPC_URL?.trim();
  if (override) return stripTrailingSlash(override);
  return `${getInstance()}/api/trpc`;
}

/** Resolve the session token: env > stored config. */
export function getSessionToken(): string | undefined {
  const fromEnv = process.env.OPENPANEL_SESSION?.trim();
  if (fromEnv) return fromEnv;
  return loadConfig().auth?.sessionToken;
}

export function getAuth(): AuthState | undefined {
  const token = getSessionToken();
  if (!token) return undefined;
  const stored = loadConfig().auth;
  if (stored?.sessionToken === token) return stored;
  // Token came from env without matching stored metadata.
  return { sessionToken: token };
}

export function setInstance(instance: string): void {
  const cfg = loadConfig();
  cfg.instance = stripTrailingSlash(instance);
  saveConfig(cfg);
}

export function setAuth(auth: AuthState): void {
  const cfg = loadConfig();
  cfg.auth = auth;
  saveConfig(cfg);
}

export function clearAuth(): void {
  const cfg = loadConfig();
  delete cfg.auth;
  saveConfig(cfg);
}

export function configPath(): string {
  return CONFIG_FILE;
}

export function deleteConfig(): void {
  try {
    rmSync(CONFIG_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
