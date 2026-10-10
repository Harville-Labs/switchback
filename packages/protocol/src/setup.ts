/**
 * Setup over the protocol: the engine asks the questions `switchback init`
 * asks, and a client (VS Code) shows each one and sends the answer back, so
 * every client sets up the same way without its own copy of the flow.
 */
import { z } from 'zod';
import type { SessionRoles } from './methods.ts';
import type { ModelRef, Tier } from './transcript.ts';

export interface SetupOption {
  label: string;
  hint?: string;
  /** Multi-select only: ticked to begin with. */
  checked?: boolean;
}

/**
 * One question. Answers: text a string; number a number, or `''` for the
 * default; confirm a boolean; select an option's index; multiSelect indexes;
 * search an index, or with `freeText` what was typed. Null cancels setup.
 */
export type SetupQuestion =
  | { kind: 'text'; question: string; default?: string }
  | { kind: 'number'; question: string; default?: number }
  | { kind: 'confirm'; question: string; default: boolean }
  | { kind: 'select'; question: string; options: SetupOption[]; default: number }
  | { kind: 'multiSelect'; question: string; options: SetupOption[] }
  /** A long list to filter as you type; with `freeText`, what was typed can be the answer. */
  | { kind: 'search'; question: string; options: SetupOption[]; freeText: boolean };

/** Something setup tells the person between questions; clients draw each kind their own way. */
export type SetupNote =
  | { kind: 'text'; text: string; tone?: 'heading' | 'detail' | 'warning' | 'success' }
  /** Which model does what, as `/roles` shows it. */
  | {
      kind: 'roles';
      roles: SessionRoles;
      models: { alias: string; ref: ModelRef; tier: Tier }[];
    }
  /** The config layer about to be written. */
  | { kind: 'config'; file: string; layer: Record<string, unknown> };

export const SetupStartParams = z.object({
  /** Where the models go; the user config unless `project`. */
  scope: z.enum(['user', 'project']).optional(),
});
export type SetupStartParams = z.infer<typeof SetupStartParams>;

export const SetupAnswerParams = z.object({
  requestId: z.string(),
  /** Null cancels setup. */
  value: z.union([z.boolean(), z.string(), z.number(), z.array(z.number().int()), z.null()]),
});
export type SetupAnswerParams = z.infer<typeof SetupAnswerParams>;

export const SetupCancelParams = z.object({ setupId: z.string() });
export type SetupCancelParams = z.infer<typeof SetupCancelParams>;

/** How a setup ended. `written`: a config file was written (restart the engine to use it). */
export interface SetupOutcome {
  outcome: 'written' | 'nothing' | 'cancelled' | 'failed';
  file?: string;
  /** For `failed`: what went wrong. */
  message?: string;
}
