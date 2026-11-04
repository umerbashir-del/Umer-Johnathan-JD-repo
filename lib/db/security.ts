import "server-only";
import { sql } from "drizzle-orm";
import type { Database } from ".";
// Static DDL only. Runtime values always use Drizzle parameters.
export async function installSecurity(db:Database){
 await installInvariantChecks(db);
 await db.execute(sql`CREATE OR REPLACE FUNCTION refuse_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_append_only'; END $$`);
 await db.execute(sql`DROP TRIGGER IF EXISTS audit_append_only ON audit_events`);
 await db.execute(sql`CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION refuse_audit_mutation()`);
 await db.execute(sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spend_rw') THEN CREATE ROLE spend_rw NOLOGIN; END IF; END $$`);
 await db.execute(sql`GRANT USAGE ON SCHEMA public TO app_rw, spend_rw`);
 await db.execute(sql`GRANT SELECT, INSERT, UPDATE ON users, cases, review_periods, authorizations, run_groups, agent_runs, packet_versions, claims, evidence_spans, claim_evidence, issues, approvals, rate_limit_counters, login_throttles TO app_rw`);
 await db.execute(sql`REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM app_rw`);
 await db.execute(sql`GRANT SELECT, INSERT ON audit_events TO app_rw`);
 await db.execute(sql`REVOKE ALL ON documents FROM app_rw`);
 await db.execute(sql`GRANT SELECT, INSERT ON documents TO app_rw`);
 await db.execute(sql`GRANT UPDATE (verification_state, verified_by, verified_at, verification_source, rejection_reason) ON documents TO app_rw`);
 await db.execute(sql`GRANT SELECT ON upload_allowlist TO app_rw`);
 await db.execute(sql`GRANT SELECT, INSERT, UPDATE ON spend_ledger, spend_reservations TO spend_rw`);
}

/** Text-backed enums and numeric invariants remain enforced for direct DB writes. */
export async function installInvariantChecks(db: Database) {
  await db.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'case_type_valid' AND conrelid = 'cases'::regclass) THEN
      ALTER TABLE cases ADD CONSTRAINT case_type_valid CHECK (type IN ('concurrent_review','denial'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_verification_valid' AND conrelid = 'documents'::regclass) THEN
      ALTER TABLE documents ADD CONSTRAINT document_verification_valid CHECK (verification_state IN ('unverified','verified','rejected'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_verification_source_valid' AND conrelid = 'documents'::regclass) THEN
      ALTER TABLE documents ADD CONSTRAINT document_verification_source_valid CHECK (verification_source IS NULL OR verification_source IN ('seed','user'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_origin_valid' AND conrelid = 'documents'::regclass) THEN
      ALTER TABLE documents ADD CONSTRAINT document_origin_valid CHECK (origin IN ('seed','allowlisted_upload','local_freeform'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_version_positive' AND conrelid = 'documents'::regclass) THEN
      ALTER TABLE documents ADD CONSTRAINT document_version_positive CHECK (version > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_period_valid' AND conrelid = 'review_periods'::regclass) THEN
      ALTER TABLE review_periods ADD CONSTRAINT review_period_valid CHECK (requested_start <= requested_end AND version > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authorization_period_valid' AND conrelid = 'authorizations'::regclass) THEN
      ALTER TABLE authorizations ADD CONSTRAINT authorization_period_valid CHECK (approved_start <= approved_end AND (units IS NULL OR units >= 0));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_group_plan_valid' AND conrelid = 'run_groups'::regclass) THEN
      ALTER TABLE run_groups ADD CONSTRAINT run_group_plan_valid CHECK (plan IN ('concurrent_review','denial','rerun'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_group_status_valid' AND conrelid = 'run_groups'::regclass) THEN
      ALTER TABLE run_groups ADD CONSTRAINT run_group_status_valid CHECK (status IN ('running','complete','partial','failed','budget_exceeded'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'run_group_counts_valid' AND conrelid = 'run_groups'::regclass) THEN
      ALTER TABLE run_groups ADD CONSTRAINT run_group_counts_valid CHECK (calls_used >= 0 AND tokens_used >= 0 AND cost_usd >= 0 AND cost_usd <> 'NaN'::numeric);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_status_valid' AND conrelid = 'agent_runs'::regclass) THEN
      ALTER TABLE agent_runs ADD CONSTRAINT agent_status_valid CHECK (status IN ('queued','running','succeeded','needs_review','failed','timed_out','skipped','replayed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_error_kind_valid' AND conrelid = 'agent_runs'::regclass) THEN
      ALTER TABLE agent_runs ADD CONSTRAINT agent_error_kind_valid CHECK (error_kind IS NULL OR error_kind IN ('timeout','api','schema','truncated','refusal','no_replay','stale','budget','spend_stop','ledger_unavailable'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_counts_valid' AND conrelid = 'agent_runs'::regclass) THEN
      ALTER TABLE agent_runs ADD CONSTRAINT agent_counts_valid CHECK (attempts BETWEEN 0 AND 2 AND (input_tokens IS NULL OR input_tokens >= 0) AND (output_tokens IS NULL OR output_tokens >= 0) AND cost_usd >= 0 AND cost_usd <> 'NaN'::numeric);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'packet_kind_valid' AND conrelid = 'packet_versions'::regclass) THEN
      ALTER TABLE packet_versions ADD CONSTRAINT packet_kind_valid CHECK (kind IN ('review_packet','appeal_letter','p2p_points','document_request') AND version > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_position_valid' AND conrelid = 'claims'::regclass) THEN
      ALTER TABLE claims ADD CONSTRAINT claim_position_valid CHECK (position >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_method_valid' AND conrelid = 'evidence_spans'::regclass) THEN
      ALTER TABLE evidence_spans ADD CONSTRAINT evidence_method_valid CHECK (method IN ('verified_quote','manual','seed_parsed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_type_valid' AND conrelid = 'issues'::regclass) THEN
      ALTER TABLE issues ADD CONSTRAINT issue_type_valid CHECK (type IN ('missing_document','date_conflict','unsupported_claim','stale_policy','extraction_uncertain','insurer_objection','other'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_severity_valid' AND conrelid = 'issues'::regclass) THEN
      ALTER TABLE issues ADD CONSTRAINT issue_severity_valid CHECK (severity IN ('critical','major','minor'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_status_valid' AND conrelid = 'issues'::regclass) THEN
      ALTER TABLE issues ADD CONSTRAINT issue_status_valid CHECK (status IN ('open','awaiting_document','in_rework','escalated','resolved'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_status_valid' AND conrelid = 'approvals'::regclass) THEN
      ALTER TABLE approvals ADD CONSTRAINT approval_status_valid CHECK (status IN ('valid','invalidated'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_actor_type_valid' AND conrelid = 'audit_events'::regclass) THEN
      ALTER TABLE audit_events ADD CONSTRAINT audit_actor_type_valid CHECK (actor_type IN ('user','agent','system'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_outcome_valid' AND conrelid = 'audit_events'::regclass) THEN
      ALTER TABLE audit_events ADD CONSTRAINT audit_outcome_valid CHECK (outcome IN ('success','refused','failed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_type_valid' AND conrelid = 'upload_allowlist'::regclass) THEN
      ALTER TABLE upload_allowlist ADD CONSTRAINT upload_type_valid CHECK (type NOT IN ('policy','criteria_summary'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spend_finite' AND conrelid = 'spend_ledger'::regclass) THEN
      ALTER TABLE spend_ledger ADD CONSTRAINT spend_finite CHECK (recorded_usd <> 'NaN'::numeric AND reserved_usd <> 'NaN'::numeric);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_status_valid' AND conrelid = 'spend_reservations'::regclass) THEN
      ALTER TABLE spend_reservations ADD CONSTRAINT reservation_status_valid CHECK (status IN ('held','settled','expired'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_environment_valid' AND conrelid = 'spend_reservations'::regclass) THEN
      ALTER TABLE spend_reservations ADD CONSTRAINT reservation_environment_valid CHECK (environment IN ('local','preview','production','eval'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reservation_amount_valid' AND conrelid = 'spend_reservations'::regclass) THEN
      ALTER TABLE spend_reservations ADD CONSTRAINT reservation_amount_valid CHECK (estimate_usd >= 0 AND estimate_usd <> 'NaN'::numeric AND (actual_usd IS NULL OR (actual_usd >= 0 AND actual_usd <> 'NaN'::numeric)));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rate_counter_nonnegative' AND conrelid = 'rate_limit_counters'::regclass) THEN
      ALTER TABLE rate_limit_counters ADD CONSTRAINT rate_counter_nonnegative CHECK (count >= 0);
    END IF;
  END $$`);
}
