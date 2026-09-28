import type { User } from '$lib/server/model';

declare global {
  namespace App {
    interface Locals {
      user: User | undefined;
    }
  }
}
