/** Shared by every domain module: the context, roles, people, sites, and the error a broken rule throws. */
import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { type Auth, OPERATOR } from '../auth.ts';
import type { Db } from '../db.ts';

export interface Ctx {
  db: Db;
  auth: Auth;
  now: () => Date;
  /** Switchback managers must sign in through Harville Labs' identity provider. */
  managerSsoRequired?: boolean;
}

/** Roles within one site. `operator` is Better Auth's organization `owner` (auth.ts). */
export const ROLES = ['operator', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
export const toPluginRole = (r: Role) => (r === 'operator' ? OPERATOR : r);
export const fromPluginRole = (r: string): Role =>
  r.split(',').includes(OPERATOR)
    ? 'operator'
    : r.split(',').includes('admin')
      ? 'admin'
      : 'member';

export interface User {
  id: string;
  email: string;
  name: string | null;
  /** Harville Labs staff: see every site, create them, and assign their operators. */
  switchbackManager: boolean;
}

/** A signed-in person: who, how they signed in, and the headers that prove it. */
export interface Actor {
  user: User;
  session: { id: string; siteId: string | null; via: string | null };
  headers: Headers;
}

export interface Site {
  id: string;
  slug: string;
  name: string;
  seats: number;
  telemetry: 'on' | 'off' | 'user';
  ssoRequired: boolean;
}

export interface Membership {
  id: string;
  role: Role;
}

/** A rule was broken; the message is shown to the person who tried. */
export class SiteError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502 = 400,
  ) {
    super(message);
    this.name = 'SiteError';
  }
}

/** Run a Better Auth call, turning its refusals into a SiteError with its message. */
export async function authCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof APIError) {
      const status = err.statusCode;
      throw new SiteError(
        err.body?.message ?? err.message ?? 'That was refused.',
        status === 403 || status === 404 || status === 409 || status === 502 ? status : 400,
      );
    }
    throw err;
  }
}

export const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter an email address.' }));

export function email(input: string): string {
  const e = Email.safeParse(input);
  if (!e.success) throw new SiteError(`"${input}" isn't an email address.`);
  return e.data;
}
