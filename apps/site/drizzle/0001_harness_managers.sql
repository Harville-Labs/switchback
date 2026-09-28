ALTER TABLE "users" RENAME COLUMN "operator" TO "harness_manager";--> statement-breakpoint
-- Owners become operators, which only Harness managers assign from here on.
UPDATE "memberships" SET "role" = 'operator' WHERE "role" = 'owner';
