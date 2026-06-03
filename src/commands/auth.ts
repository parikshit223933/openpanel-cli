import type { Command } from 'commander';
import prompts from 'prompts';
import {
  clearAuth,
  getAuth,
  getInstance,
  setAuth,
  setInstance,
} from '../config.js';
import {
  extractCookieValue,
  extractSessionCookie,
  trpcMutate,
  trpcMutateRaw,
  trpcQuery,
  TrpcError,
} from '../trpc.js';
import { zSignInEmail } from '../schemas.js';
import { c, errorLine, info, render, success } from '../output.js';

interface SessionInfo {
  userId: string | null;
  user: { email?: string; firstName?: string; lastName?: string } | null;
  session: { id?: string; expiresAt?: string | Date } | null;
}

async function fetchSession(sessionToken?: string): Promise<SessionInfo> {
  return trpcQuery<SessionInfo>('auth.session', undefined, { sessionToken });
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Sign in to OpenPanel (email/password, or paste a session cookie)')
    .option('-e, --email <email>', 'Account email')
    .option('-p, --password <password>', 'Account password (you will be prompted if omitted)')
    .option('--cookie <session>', 'Use an existing `session` cookie value from your browser')
    .option('--instance <url>', 'OpenPanel base URL (persisted), e.g. https://dashboard.openpanel.dev')
    .action(async (opts) => {
      if (opts.instance) setInstance(opts.instance);

      // ── Path 1: paste a session cookie from the browser ──
      if (opts.cookie) {
        const session = await fetchSession(opts.cookie);
        if (!session?.userId) {
          throw new TrpcError(
            'That session cookie is not valid (no active user). Copy a fresh `session` cookie from your browser DevTools → Application → Cookies.',
          );
        }
        setAuth({
          sessionToken: opts.cookie,
          email: session.user?.email,
          expiresAt: toIso(session.session?.expiresAt),
        });
        success(`Logged in as ${c.bold(session.user?.email ?? session.userId)} (via cookie)`);
        return;
      }

      // ── Path 2: email + password ──
      const email =
        opts.email ?? process.env.OPENPANEL_EMAIL ?? (await ask('text', 'email', 'Email'));
      const password =
        opts.password ??
        process.env.OPENPANEL_PASSWORD ??
        (await ask('password', 'password', 'Password'));

      const parsed = zSignInEmail.safeParse({ email, password });
      if (!parsed.success) {
        throw new TrpcError(
          `Invalid credentials format: ${parsed.error.issues
            .map((i) => i.message)
            .join(', ')}`,
        );
      }

      info(`Signing in to ${c.dim(getInstance())} …`);

      let signIn;
      try {
        signIn = await trpcMutateRaw<{ type: string }>(
          'auth.signInEmail',
          parsed.data,
          { anonymous: true },
        );
      } catch (e) {
        if (e instanceof TrpcError && e.httpStatus === 429) {
          throw new TrpcError('Too many sign-in attempts. Wait ~30s and try again.');
        }
        throw e;
      }

      let setCookies = signIn.setCookies;

      // ── 2FA challenge, if enabled ──
      if (signIn.data?.type === 'totp_required') {
        const challenge = extractCookieValue(signIn.setCookies, '2fa_challenge');
        if (!challenge) {
          throw new TrpcError('2FA required but no challenge cookie was returned by the server.');
        }
        const code = await ask('text', 'code', 'Two-factor code (or recovery code)');
        const totp = await trpcMutateRaw<{ type: string }>(
          'auth.signInTotp',
          { code: String(code).trim() },
          { cookieHeader: `2fa_challenge=${encodeURIComponent(challenge)}` },
        );
        setCookies = totp.setCookies;
      }

      const session = extractSessionCookie(setCookies);
      if (!session) {
        throw new TrpcError('Sign-in succeeded but no session cookie was returned. Cannot continue.');
      }

      // Confirm and capture the user identity.
      const me = await fetchSession(session.token);
      setAuth({
        sessionToken: session.token,
        email: me.user?.email ?? String(email),
        expiresAt: toIso(me.session?.expiresAt) ?? session.expiresAt,
      });
      success(`Logged in as ${c.bold(me.user?.email ?? String(email))}`);
    });

  program
    .command('logout')
    .description('Sign out and clear stored credentials')
    .action(async () => {
      const auth = getAuth();
      if (!auth) {
        info('Not logged in.');
        return;
      }
      try {
        await trpcMutate('auth.signOut');
      } catch {
        // Server-side invalidation is best-effort; always clear locally.
      }
      clearAuth();
      success('Logged out.');
    });

  program
    .command('whoami')
    .description('Show the currently authenticated user')
    .action(async () => {
      const auth = getAuth();
      if (!auth) {
        render({ loggedIn: false }, () => errorLine('Not logged in. Run `openpanel login`.'));
        process.exitCode = 1;
        return;
      }
      const me = await fetchSession();
      if (!me?.userId) {
        render({ loggedIn: false }, () =>
          errorLine('Session expired or invalid. Run `openpanel login` again.'),
        );
        process.exitCode = 1;
        return;
      }
      const out = {
        loggedIn: true,
        email: me.user?.email ?? null,
        userId: me.userId,
        instance: getInstance(),
        expiresAt: toIso(me.session?.expiresAt) ?? auth.expiresAt ?? null,
      };
      render(out, () => {
        success(`Logged in as ${c.bold(out.email ?? out.userId)}`);
        info(`Instance:   ${out.instance}`);
        info(`User ID:    ${out.userId}`);
        if (out.expiresAt) info(`Expires:    ${out.expiresAt}`);
      });
    });
}

async function ask(
  type: 'text' | 'password',
  name: string,
  message: string,
): Promise<string> {
  const res = await prompts(
    { type, name, message },
    { onCancel: () => process.exit(130) },
  );
  return res[name];
}

function toIso(value?: string | Date): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return value;
}
