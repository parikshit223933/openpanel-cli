import superjson from 'superjson';
import { getSessionToken, getTrpcUrl } from './config.js';

/** Error thrown for any tRPC-level or transport-level failure. */
export class TrpcError extends Error {
  httpStatus?: number;
  code?: string;
  zodError?: unknown;
  path?: string;

  constructor(
    message: string,
    opts: {
      httpStatus?: number;
      code?: string;
      zodError?: unknown;
      path?: string;
    } = {},
  ) {
    super(message);
    this.name = 'TrpcError';
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
    this.zodError = opts.zodError;
    this.path = opts.path;
  }

  /** Genuine authentication failure (missing/expired session) — suggest re-login. */
  get isAuthError(): boolean {
    return (
      this.code === 'NO_AUTH' ||
      /not authenticated|failed to get user/i.test(this.message)
    );
  }

  /** Authorization failure — authenticated, but lacking access to the resource. */
  get isAccessError(): boolean {
    return (
      !this.isAuthError &&
      (this.code === 'FORBIDDEN' ||
        this.httpStatus === 403 ||
        this.code === 'UNAUTHORIZED' ||
        /do not have access/i.test(this.message))
    );
  }

  /** Referenced record does not exist. */
  get isNotFound(): boolean {
    return this.code === 'NOT_FOUND' || this.httpStatus === 404;
  }
}

export interface CallOptions {
  /** Override the session token (used during login, before it is persisted). */
  sessionToken?: string;
  /** Raw Cookie header to send verbatim (used for the 2FA challenge flow). */
  cookieHeader?: string;
  /** Skip attaching any auth cookie. */
  anonymous?: boolean;
}

export interface RawResponse<T> {
  data: T;
  /** Raw Set-Cookie header values returned by the server. */
  setCookies: string[];
}

type ProcedureType = 'query' | 'mutation';

async function call<T>(
  type: ProcedureType,
  path: string,
  input: unknown,
  opts: CallOptions = {},
): Promise<RawResponse<T>> {
  const url = `${getTrpcUrl()}/${path}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };

  if (opts.cookieHeader) {
    headers.cookie = opts.cookieHeader;
  } else {
    const token = opts.anonymous
      ? undefined
      : (opts.sessionToken ?? getSessionToken());
    if (token) headers.cookie = `session=${token}`;
  }

  let res: Response;
  try {
    if (type === 'query') {
      const qs =
        input === undefined
          ? ''
          : `?input=${encodeURIComponent(
              JSON.stringify(superjson.serialize(input)),
            )}`;
      res = await fetch(url + qs, { method: 'GET', headers });
    } else {
      const body =
        input === undefined
          ? undefined
          : JSON.stringify(superjson.serialize(input));
      res = await fetch(url, { method: 'POST', headers, body });
    }
  } catch (e) {
    throw new TrpcError(
      `Could not reach OpenPanel at ${getTrpcUrl()} — ${
        e instanceof Error ? e.message : String(e)
      }`,
      { path },
    );
  }

  const setCookies = readSetCookies(res);
  const text = await res.text();

  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new TrpcError(
      `Unexpected non-JSON response from ${path} (HTTP ${res.status})`,
      { httpStatus: res.status, path },
    );
  }

  if (json?.error) {
    const err = json.error.json ?? json.error;
    const data = err?.data ?? {};
    const rawMessage = err?.message ?? `Request to ${path} failed`;

    // The server uses Prisma's `findUniqueOrThrow` for lookups, which surfaces
    // as a raw 500 + stack when an id doesn't exist. Translate that (and real
    // NOT_FOUND codes) into a clean message instead of leaking Prisma internals.
    const looksNotFound =
      data.code === 'NOT_FOUND' ||
      /no record was found|finduniqueorthrow|findfirstorthrow/i.test(rawMessage);
    if (looksNotFound) {
      throw new TrpcError(
        `Not found — a referenced record (e.g. project, dashboard, report, or rule id) does not exist. Check the id; run the matching \`list\` command to see valid ids.`,
        { httpStatus: 404, code: 'NOT_FOUND', path },
      );
    }

    throw new TrpcError(rawMessage, {
      httpStatus: data.httpStatus ?? res.status,
      code: data.code,
      zodError: data.zodError ?? undefined,
      path,
    });
  }

  if (!res.ok) {
    throw new TrpcError(`Request to ${path} failed (HTTP ${res.status})`, {
      httpStatus: res.status,
      path,
    });
  }

  const payload = json?.result?.data;
  const value =
    payload === undefined ? undefined : (superjson.deserialize(payload) as T);
  return { data: value as T, setCookies };
}

export async function trpcQuery<T = unknown>(
  path: string,
  input?: unknown,
  opts?: CallOptions,
): Promise<T> {
  const { data } = await call<T>('query', path, input, opts);
  return data;
}

export async function trpcMutate<T = unknown>(
  path: string,
  input?: unknown,
  opts?: CallOptions,
): Promise<T> {
  const { data } = await call<T>('mutation', path, input, opts);
  return data;
}

/** Like trpcMutate but also returns Set-Cookie values (needed for login). */
export async function trpcMutateRaw<T = unknown>(
  path: string,
  input?: unknown,
  opts?: CallOptions,
): Promise<RawResponse<T>> {
  return call<T>('mutation', path, input, opts);
}

function readSetCookies(res: Response): string[] {
  const anyHeaders = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof anyHeaders.getSetCookie === 'function') {
    return anyHeaders.getSetCookie();
  }
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

/** Extract a single cookie value by name from Set-Cookie values. */
export function extractCookieValue(
  setCookies: string[],
  name: string,
): string | undefined {
  const re = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`);
  for (const raw of setCookies) {
    const match = re.exec(raw);
    if (match?.[1]) {
      const value = decodeURIComponent(match[1]);
      if (value) return value;
    }
  }
  return undefined;
}

/** Extract the `session` cookie token (and expiry) from Set-Cookie values. */
export function extractSessionCookie(
  setCookies: string[],
): { token: string; expiresAt?: string } | undefined {
  for (const raw of setCookies) {
    const match = /(?:^|,\s*)session=([^;]+)/.exec(raw);
    if (!match || !match[1]) continue;
    const token = decodeURIComponent(match[1]);
    if (!token) continue;

    let expiresAt: string | undefined;
    const maxAge = /max-age=(\d+)/i.exec(raw);
    if (maxAge && maxAge[1]) {
      expiresAt = new Date(Date.now() + Number(maxAge[1]) * 1000).toISOString();
    } else {
      const expires = /expires=([^;]+)/i.exec(raw);
      if (expires && expires[1]) {
        const d = new Date(expires[1]);
        if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
      }
    }
    return { token, expiresAt };
  }
  return undefined;
}
