import { hasAcceptedSemanticResult } from "./heartbeat-run-summary.js";
import { and, eq, isNull, or } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";
import { decideSecondaryAdapterFallback, type SecondaryAdapterFailureReason } from "./secondary-adapter-fallback.js";

/** Internal executor boundary: never accepts a wake payload as authorization. */
export async function reserveSecondaryAdapterAttempt(db: Db, input: {
  companyId: string;
  agentId: string;
  primaryRunId: string;
  providerStopped: boolean;
  completed: boolean;
  failureReason: SecondaryAdapterFailureReason | null;
}) {
  return db.transaction(async (tx) => {
    // Serialize against other controllers and reserve wake + run in one commit.
    const [primary] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.primaryRunId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
    )).for("update");
    if (!primary || legacyExecutionNeedsReconciliation(primary)) return null;
    const [agent] = await tx.select().from(agents).where(and(
      eq(agents.id, input.agentId), eq(agents.companyId, input.companyId),
    ));
    if (!agent) return null;
    const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(or(eq(heartbeatRuns.fallbackOfRunId, primary.id), eq(heartbeatRuns.retryOfRunId, primary.id))).limit(1);
    const [nativeResult] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults)
      .where(eq(nativeRunResults.runId, primary.id)).limit(1);
    const [coordinator] = await tx.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, primary.id)).limit(1);
    const decision = decideSecondaryAdapterFallback({
      configured: Boolean(agent.secondaryAdapterType),
      alreadyAttempted: Boolean(primary.fallbackOfRunId || primary.retryOfRunId || successor),
      cancelled: !["failed", "timed_out"].includes(primary.status) || ["paused", "terminated", "pending_approval"].includes(agent.status),
      completed: input.completed || hasAcceptedSemanticResult(primary.resultJson) || Boolean(nativeResult || coordinator?.resultId),
      providerStopped: input.providerStopped && (!coordinator || coordinator.phase === "terminal_failure"),
      failureReason: input.failureReason,
    });
    if (!decision.fallback) return null;
    const issueId = primary.contextSnapshot?.issueId ?? primary.contextSnapshot?.taskId;
    const [issue] = primary.runtimeMode !== "native" && typeof issueId === "string"
      ? await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId))).for("update")
      : [];
    // A competing claim or reassignment wins; never reserve parallel provider work.
    if (issue && (issue.assigneeAgentId !== primary.agentId ||
        (issue.executionRunId && issue.executionRunId !== primary.id))) return null;

    // Only copy task routing. Session, continuation, interaction delivery and
    // authorization attestations belong to the primary adapter/run.
    const source = primary.contextSnapshot ?? {};
    const context: Record<string, unknown> = {};
    for (const key of ["issueId", "taskId", "taskKey", "projectId"]) {
      if (typeof source[key] === "string") context[key] = source[key];
    }
    context.wakeReason = "secondary_adapter_fallback";
    const [wake] = await tx.insert(agentWakeupRequests).values({
      companyId: primary.companyId, agentId: primary.agentId,
      source: "automation", triggerDetail: "system", reason: "secondary_adapter_fallback",
      requestedByActorType: "system", idempotencyKey: `secondary-adapter:${primary.id}`,
      payload: context,
    }).returning();
    const [run] = await tx.insert(heartbeatRuns).values({
      companyId: primary.companyId, agentId: primary.agentId,
      invocationSource: "automation", triggerDetail: "system", status: "queued",
      responsibleUserId: primary.responsibleUserId, wakeupRequestId: wake.id,
      contextSnapshot: context, sessionIdBefore: null,
      fallbackOfRunId: primary.id, fallbackReason: decision.reason,
      executionAdapterType: agent.secondaryAdapterType,
    }).returning();
    await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    if (issue) await tx.update(issues).set({
      executionRunId: run.id, executionLockedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(issues.id, issue.id), eq(issues.companyId, input.companyId)));

    return run;
  });
}

/** A persisted, company/agent-scoped lineage is the sole secondary selector. */
export async function resolveSecondaryExecutionAgent(db: Db, agent: typeof agents.$inferSelect, run: typeof heartbeatRuns.$inferSelect) {
  if (!run.fallbackOfRunId) return agent;
  const [primary] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.fallbackOfRunId), eq(heartbeatRuns.companyId, agent.companyId),
    eq(heartbeatRuns.agentId, agent.id), isNull(heartbeatRuns.fallbackOfRunId), isNull(heartbeatRuns.retryOfRunId),
  ));
  if (!primary || !agent.secondaryAdapterType || run.executionAdapterType !== agent.secondaryAdapterType) {
    throw new Error("Secondary adapter attempt no longer matches its persisted execution identity");
  }
  return { ...agent, adapterType: agent.secondaryAdapterType, adapterConfig: agent.secondaryAdapterConfig ?? {} };
}
