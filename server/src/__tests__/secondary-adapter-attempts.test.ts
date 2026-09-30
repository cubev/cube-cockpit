import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentRuntimeState, agentWakeupRequests, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { reserveSecondaryAdapterAttempt, resolveSecondaryExecutionAgent } from "../services/secondary-adapter-attempts.js";

import { heartbeatService } from "../services/heartbeat.js";
import { registerServerAdapter, unregisterServerAdapter, type ServerAdapterModule } from "../adapters/index.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("secondary adapter attempt reservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("secondary-attempt-reservation-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(options: { configured?: boolean; status?: string; agentStatus?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Attempt fixture", defaultResponsibleUserId: "fixture-owner", issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Attempt fixture", status: options.agentStatus ?? "idle",
      adapterType: "codex_local", adapterConfig: { model: "primary" },
      secondaryAdapterType: options.configured === false ? null : "claude_local",
      secondaryAdapterConfig: options.configured === false ? null : { model: "secondary" },
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: options.status ?? "failed",
      contextSnapshot: { taskKey: "fixture-task", resumeSessionParams: { sessionId: "primary-session" },
        executionContinuation: { attacker: true }, secondaryAdapter: true, paperclipWakePayload: { attested: true } },
      sessionIdBefore: "primary-session", sessionIdAfter: "primary-session",
    }).returning();
    return { agent, run, input: { companyId, agentId, primaryRunId: run.id, providerStopped: true, completed: false, failureReason: "network" as const } };
  }

  it("atomically reserves one successor and wake under competing controllers", async () => {
    const { agent, run, input } = await fixture();
    const attempts = await Promise.all([reserveSecondaryAdapterAttempt(db, input), reserveSecondaryAdapterAttempt(db, input)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const secondary = attempts.find(Boolean)!;
    expect(secondary).toMatchObject({ fallbackOfRunId: run.id, fallbackReason: "network", executionAdapterType: "claude_local", sessionIdBefore: null,
      contextSnapshot: { taskKey: "fixture-task", wakeReason: "secondary_adapter_fallback" } });
    expect(secondary.contextSnapshot).not.toHaveProperty("resumeSessionParams");
    expect(secondary.contextSnapshot).not.toHaveProperty("executionContinuation");
    expect(secondary.contextSnapshot).not.toHaveProperty("paperclipWakePayload");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent.id))).toHaveLength(1);
    expect(await resolveSecondaryExecutionAgent(db, agent, secondary)).toMatchObject({ adapterType: "claude_local", adapterConfig: { model: "secondary" } });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, secondary.id));
    expect(await reserveSecondaryAdapterAttempt(db, { ...input, primaryRunId: secondary.id })).toBeNull();
  });

  it.each([
    { name: "provider still running", patch: { providerStopped: false } },
    { name: "accepted result before teardown failure", patch: { completed: true } },
    { name: "control plane failure", patch: { failureReason: null } },
  ])("refuses $name without creating a wake", async ({ patch }) => {
    const { input } = await fixture();
    expect(await reserveSecondaryAdapterAttempt(db, { ...input, ...patch })).toBeNull();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, input.agentId))).toHaveLength(0);
  });

  it.each([
    { configured: false }, { status: "cancelled" }, { status: "succeeded" }, { agentStatus: "paused" }, { agentStatus: "terminated" },
  ])("preserves admission boundaries for %j", async (options) => {
    const { input } = await fixture(options);
    expect(await reserveSecondaryAdapterAttempt(db, input)).toBeNull();
  });

  it("executes a reserved secondary with resolved model and isolated runtime session", async () => {
    const { agent, input } = await fixture();
    await db.insert(agentRuntimeState).values({ agentId: agent.id, companyId: agent.companyId,
      adapterType: "codex_local", sessionId: "primary-provider-session", stateJson: { primaryOnly: true } });
    const secondary = (await reserveSecondaryAdapterAttempt(db, input))!;
    const execute = vi.fn<ServerAdapterModule["execute"]>().mockImplementation(async (ctx) => {
      expect(ctx.agent.adapterType).toBe("claude_local");
      expect(ctx.config.model).toBe("secondary");
      expect(ctx.runtime.sessionId).toBeNull();
      expect(ctx.context).not.toHaveProperty("resumeSessionParams");
      await ctx.onProviderStopped?.();
      return { exitCode: 0, signal: null, timedOut: false, model: "actual-secondary", summary: "Completed." };
    });
    registerServerAdapter({ type: "claude_local", supportsLocalAgentJwt: false, execute,
      testEnvironment: async () => ({ adapterType: "claude_local", status: "pass", checks: [], testedAt: new Date(0).toISOString() }) });
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(execute).toHaveBeenCalledOnce();
      expect(await heartbeat.getRun(secondary.id)).toMatchObject({ status: "succeeded", executionAdapterType: "claude_local", executionModel: "actual-secondary" });
      const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agent.id));
      expect(runtime).toMatchObject({ adapterType: "codex_local", sessionId: "primary-provider-session", stateJson: { primaryOnly: true } });
    } finally {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      unregisterServerAdapter("claude_local");
    }
  });

  it("rejects cross-company/agent requests and adapter edits after reservation", async () => {
    const first = await fixture(), second = await fixture();
    expect(await reserveSecondaryAdapterAttempt(db, { ...first.input, companyId: second.input.companyId })).toBeNull();
    expect(await reserveSecondaryAdapterAttempt(db, { ...first.input, agentId: second.input.agentId })).toBeNull();
    const secondary = (await reserveSecondaryAdapterAttempt(db, first.input))!;
    await expect(resolveSecondaryExecutionAgent(db, second.agent, secondary)).rejects.toThrow("persisted execution identity");
    await db.update(agents).set({ secondaryAdapterType: "codex_local" }).where(and(eq(agents.id, first.agent.id), eq(agents.companyId, first.agent.companyId)));
    const [edited] = await db.select().from(agents).where(eq(agents.id, first.agent.id));
    await expect(resolveSecondaryExecutionAgent(db, edited, secondary)).rejects.toThrow("persisted execution identity");
  });
});
