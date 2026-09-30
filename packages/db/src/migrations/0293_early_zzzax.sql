ALTER TABLE "agents" ADD COLUMN "secondary_adapter_type" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "secondary_adapter_config" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_adapter_type" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_model" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_agent_run_uq" UNIQUE("company_id","agent_id","id");--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_fallback_predecessor_fk" FOREIGN KEY ("company_id","agent_id","fallback_of_run_id") REFERENCES "public"."heartbeat_runs"("company_id","agent_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_fallback_predecessor_uq" ON "heartbeat_runs" USING btree ("fallback_of_run_id") WHERE "heartbeat_runs"."fallback_of_run_id" is not null;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_fallback_not_self" CHECK ("heartbeat_runs"."fallback_of_run_id" is null or "heartbeat_runs"."fallback_of_run_id" <> "heartbeat_runs"."id");