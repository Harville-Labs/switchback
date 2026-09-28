CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"actor_id" text,
	"action" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"site_id" text NOT NULL,
	"status" text NOT NULL,
	"user_id" text,
	"client" text,
	"expires_at" timestamp with time zone NOT NULL,
	"last_poll_at" timestamp with time zone,
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"client" text,
	"access_hash" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_hash" text NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_access_hash_unique" UNIQUE("access_hash"),
	CONSTRAINT "devices_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
CREATE TABLE "login_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"next" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memberships_site_id_user_id_pk" PRIMARY KEY("site_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"site_id" text NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "policies_site_id_version_pk" PRIMARY KEY("site_id","version")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"seats" integer NOT NULL,
	"telemetry" text DEFAULT 'on' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sites_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "telemetry_reports" (
	"install_id" text NOT NULL,
	"day" text NOT NULL,
	"site_id" text,
	"report" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telemetry_reports_install_id_day_pk" PRIMARY KEY("install_id","day")
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"site_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"tier" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"calls" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	CONSTRAINT "usage_daily_site_id_user_id_date_tier_provider_model_pk" PRIMARY KEY("site_id","user_id","date","tier","provider","model")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"operator" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry_reports" ADD CONSTRAINT "telemetry_reports_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_by_site" ON "audit_log" USING btree ("site_id","at");--> statement-breakpoint
CREATE INDEX "devices_by_member" ON "devices" USING btree ("site_id","user_id");--> statement-breakpoint
CREATE INDEX "telemetry_by_day" ON "telemetry_reports" USING btree ("day");