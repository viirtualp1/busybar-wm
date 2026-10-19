import { randomBytes } from 'node:crypto';

/**
 * Who an app on the display socket is allowed to say it is.
 *
 * The supervisor hands each app it starts a token in `WM_TOKEN`, made fresh for
 * this run of the daemon. A hello under a name that has one must carry it, so a
 * stray process cannot draw as dota. A name that was never given a token — an
 * app started by hand — is taken at its word, the way its draws through the
 * proxy always were.
 */
export class Tokens {
  private readonly tokens = new Map<string, string>();

  issue(name: string): string {
    const existing = this.tokens.get(name);
    if (existing) {
      return existing;
    }
    const token = randomBytes(16).toString('hex');
    this.tokens.set(name, token);

    return token;
  }

  /** Whether `token` lets a session speak as `name`. */
  admits(name: string, token: string | undefined): boolean {
    const expected = this.tokens.get(name);

    return expected === undefined || expected === token;
  }
}
