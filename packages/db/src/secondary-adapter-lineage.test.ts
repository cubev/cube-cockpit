import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("secondary adapter lineage migration", () => {
  it("preserves defaults and fences concurrent, foreign-owner and self-linked attempts", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-secondary-lineage-");
    const sql = postgres(database.connectionString, { max: 2, onnotice: () => {} });
    try {
      const company = randomUUID(), otherCompany = randomUUID();
      const agent = randomUUID(), otherAgent = randomUUID(), foreignAgent = randomUUID();
      const primary = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
        (${company}, 'Fallback fixture', 'FBA'), (${otherCompany}, 'Foreign fixture', 'FBB')`;
      await sql`INSERT INTO agents (id, company_id, name) VALUES
        (${agent}, ${company}, 'Primary'), (${otherAgent}, ${company}, 'Other'),
        (${foreignAgent}, ${otherCompany}, 'Foreign')`;
      await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id) VALUES (${primary}, ${company}, ${agent})`;
      const [config] = await sql`SELECT secondary_adapter_type, secondary_adapter_config FROM agents WHERE id = ${agent}`;
      expect(config).toEqual({ secondary_adapter_type: null, secondary_adapter_config: null });
      const [run] = await sql`SELECT fallback_of_run_id, fallback_reason, execution_adapter_type, execution_model
        FROM heartbeat_runs WHERE id = ${primary}`;
      expect(run).toEqual({ fallback_of_run_id: null, fallback_reason: null, execution_adapter_type: null, execution_model: null });

      await expect(sql`INSERT INTO heartbeat_runs (company_id, agent_id, fallback_of_run_id)
        VALUES (${otherCompany}, ${foreignAgent}, ${primary})`).rejects.toMatchObject({ code: "23503" });
      await expect(sql`INSERT INTO heartbeat_runs (company_id, agent_id, fallback_of_run_id)
        VALUES (${company}, ${otherAgent}, ${primary})`).rejects.toMatchObject({ code: "23503" });
      await expect(sql`UPDATE heartbeat_runs SET fallback_of_run_id = ${primary} WHERE id = ${primary}`)
        .rejects.toMatchObject({ code: "23514" });

      const attempts = await Promise.allSettled([0, 1].map(() => sql`
        INSERT INTO heartbeat_runs (company_id, agent_id, fallback_of_run_id, fallback_reason, execution_adapter_type, execution_model)
        VALUES (${company}, ${agent}, ${primary}, 'network', 'claude_local', 'fixture-model') RETURNING id
      `));
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "23505" });
      expect(await sql`SELECT id FROM heartbeat_runs WHERE fallback_of_run_id = ${primary}`).toHaveLength(1);
      // Bulk company/agent cleanup still works with a self-referencing lineage.
      await sql`DELETE FROM heartbeat_runs WHERE company_id = ${company}`;
      expect(await sql`SELECT id FROM heartbeat_runs WHERE company_id = ${company}`).toHaveLength(0);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
