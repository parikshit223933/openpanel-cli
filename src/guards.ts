import { getSessionToken } from './config.js';
import { TrpcError } from './trpc.js';

/** Ensure a session token is available, else throw a friendly error. */
export function requireAuth(): string {
  const token = getSessionToken();
  if (!token) {
    throw new TrpcError('Not logged in. Run `openpanel login` first.', {
      code: 'NO_AUTH',
    });
  }
  return token;
}
