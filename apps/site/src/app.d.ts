import type { Actor, User } from '$lib/server/model';

declare global {
  namespace App {
    interface Locals {
      actor: Actor | undefined;
      user: User | undefined;
    }
  }
}
