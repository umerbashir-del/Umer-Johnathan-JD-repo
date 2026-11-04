CREATE TABLE "login_throttles" (
	"key" text PRIMARY KEY NOT NULL,
	"failure_times" timestamp with time zone[] DEFAULT '{}' NOT NULL,
	"blocked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
