CREATE TYPE "public"."case_status" AS ENUM('imported', 'processing', 'needs_review', 'rework', 'awaiting_document', 'escalated', 'ready_for_approval', 'approved_for_submission', 'submitted', 'pended_for_info', 'payer_approved', 'partially_approved', 'denied', 'appeal_in_progress', 'appeal_overturned', 'appeal_upheld', 'closed');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('agent_prepared', 'source_verified', 'unsupported', 'clinician_edited', 'clinician_approved', 'stale', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('clinical_fact', 'administrative_fact', 'criteria_finding', 'narrative', 'objection');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('intake', 'treatment_plan', 'progress_note', 'authorization_record', 'denial_letter', 'approval_letter', 'request_for_info_letter', 'appeal_decision_letter', 'policy', 'criteria_summary');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('clinician', 'coordinator', 'supervisor');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('direct_quote', 'extracted_fact', 'clinician_text', 'agent_synthesis');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"run_group_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"agent_version" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_document_ids" uuid[] NOT NULL,
	"output" jsonb,
	"quote_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"error_kind" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowed_agent" CHECK ("agent_runs"."agent" in ('clinical_documentation','case_assembly_drafting','independent_quality'))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"packet_version_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"role" text NOT NULL,
	"acknowledgement" text NOT NULL,
	"status" text NOT NULL,
	"invalidated_reason" text,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinician_approval" CHECK ("approvals"."role" = 'clinician')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"actor_type" text NOT NULL,
	"case_id" text,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text,
	"object_version" text,
	"outcome" text NOT NULL,
	"reason_code" text,
	"before" jsonb,
	"after" jsonb,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"auth_number" text NOT NULL,
	"status" text NOT NULL,
	"approved_start" date NOT NULL,
	"approved_end" date NOT NULL,
	"units" integer,
	"source_document_id" uuid,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"patient_label" text NOT NULL,
	"service" text NOT NULL,
	"level_of_care" text NOT NULL,
	"facility" text NOT NULL,
	"payer" text NOT NULL,
	"plan" text NOT NULL,
	"assigned_to" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"status" "case_status" NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthetic_only" CHECK ("cases"."synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"claim_id" uuid NOT NULL,
	"evidence_span_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_evidence_claim_id_evidence_span_id_pk" PRIMARY KEY("claim_id","evidence_span_id")
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"packet_version_id" uuid NOT NULL,
	"section_heading" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"type" "claim_type" NOT NULL,
	"source_kind" "source_kind" NOT NULL,
	"status" "claim_status" NOT NULL,
	"material" boolean DEFAULT true NOT NULL,
	"author" text NOT NULL,
	"agent_run_id" uuid,
	"fact_ids" text[] DEFAULT '{}' NOT NULL,
	"boundary_flagged" boolean DEFAULT false NOT NULL,
	"original_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text,
	"type" "document_type" NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"service_date" date,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"supersedes_id" uuid,
	"verification_state" text DEFAULT 'unverified' NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"verification_source" text,
	"rejection_reason" text,
	"origin" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_content_cap" CHECK (length("documents"."content") between 1 and 30000),
	CONSTRAINT "document_case_required" CHECK ("documents"."case_id" is not null or "documents"."type" = 'criteria_summary')
);
--> statement-breakpoint
CREATE TABLE "evidence_spans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"excerpt" text NOT NULL,
	"section" text,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "valid_offsets" CHECK ("evidence_spans"."start_offset" >= 0 and "evidence_spans"."end_offset" > "evidence_spans"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"blocking" boolean NOT NULL,
	"owner_id" uuid,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"source_run_id" uuid,
	"description" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"required_document_type" "document_type",
	"required_service_date" date,
	"due_at" timestamp with time zone,
	"resolution" text,
	"resolution_reason" text,
	"resolution_evidence_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packet_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text DEFAULT 'review_packet' NOT NULL,
	"content" jsonb NOT NULL,
	"included_claim_ids" uuid[] NOT NULL,
	"content_hash" text NOT NULL,
	"hash_input" jsonb NOT NULL,
	"validation_report" jsonb NOT NULL,
	"run_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_counters" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_counters_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "review_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"requested_start" date NOT NULL,
	"requested_end" date NOT NULL,
	"review_point" text,
	"version" integer NOT NULL,
	"source_document_id" uuid,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"verification_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"plan" text DEFAULT 'concurrent_review' NOT NULL,
	"status" text NOT NULL,
	"calls_used" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"replayed" boolean DEFAULT false NOT NULL,
	"started_by" uuid,
	"as_of" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"recorded_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"reserved_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_only" CHECK ("spend_ledger"."id"='global'),
	CONSTRAINT "positive_spend" CHECK ("spend_ledger"."recorded_usd">=0 and "spend_ledger"."reserved_usd">=0)
);
--> statement-breakpoint
CREATE TABLE "spend_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"agent_run_ref" text,
	"estimate_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"actual_usd" numeric(10, 6),
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_allowlist" (
	"content_hash" text NOT NULL,
	"case_id" text NOT NULL,
	"type" "document_type" NOT NULL,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"service_date" date,
	"fixture_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_allowlist_content_hash_case_id_pk" PRIMARY KEY("content_hash","case_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_key" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_account_key_unique" UNIQUE("account_key"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "documents_case_unique" ON "documents" USING btree ("id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "packet_case_unique" ON "packet_versions" USING btree ("id","case_id");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_packet_version_id_case_id_packet_versions_id_case_id_fk" FOREIGN KEY ("packet_version_id","case_id") REFERENCES "public"."packet_versions"("id","case_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_source_document_id_case_id_documents_id_case_id_fk" FOREIGN KEY ("source_document_id","case_id") REFERENCES "public"."documents"("id","case_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_packet_version_id_case_id_packet_versions_id_case_id_fk" FOREIGN KEY ("packet_version_id","case_id") REFERENCES "public"."packet_versions"("id","case_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_supersedes_id_documents_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evidence_spans" ADD CONSTRAINT "evidence_spans_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_source_run_id_agent_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_resolution_evidence_id_case_id_documents_id_case_id_fk" FOREIGN KEY ("resolution_evidence_id","case_id") REFERENCES "public"."documents"("id","case_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "packet_versions" ADD CONSTRAINT "packet_versions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "packet_versions" ADD CONSTRAINT "packet_versions_run_group_id_run_groups_id_fk" FOREIGN KEY ("run_group_id") REFERENCES "public"."run_groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "review_periods" ADD CONSTRAINT "review_periods_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "review_periods" ADD CONSTRAINT "review_periods_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "review_periods" ADD CONSTRAINT "review_periods_source_document_id_case_id_documents_id_case_id_fk" FOREIGN KEY ("source_document_id","case_id") REFERENCES "public"."documents"("id","case_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "run_groups" ADD CONSTRAINT "run_groups_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "run_groups" ADD CONSTRAINT "run_groups_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "upload_allowlist" ADD CONSTRAINT "upload_allowlist_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "one_agent_per_group" ON "agent_runs" USING btree ("run_group_id","agent");--> statement-breakpoint
CREATE UNIQUE INDEX "one_valid_approval" ON "approvals" USING btree ("packet_version_id") WHERE "approvals"."status" = 'valid';--> statement-breakpoint
CREATE UNIQUE INDEX "open_issue_dedupe" ON "issues" USING btree ("case_id","dedupe_key") WHERE "issues"."status" <> 'resolved';--> statement-breakpoint
CREATE UNIQUE INDEX "packet_version" ON "packet_versions" USING btree ("case_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "review_period_version" ON "review_periods" USING btree ("case_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_run" ON "run_groups" USING btree ("case_id") WHERE "run_groups"."status" = 'running';