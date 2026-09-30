/** Only execution failures can switch providers; control-plane failures cannot. */
export type SecondaryAdapterFailureReason =
  | "adapter_failure"
  | "authentication"
  | "quota"
  | "rate_limit"
  | "provider"
  | "network"
  | "timeout";

export type SecondaryAdapterFallbackDecision =
  | { fallback: true; reason: SecondaryAdapterFailureReason }
  | {
      fallback: false;
      reason: "not_configured" | "already_attempted" | "cancelled" | "completed" | "provider_still_running" | "not_execution_failure";
    };

/**
 * Call after the primary provider has stopped, using server-owned completion
 * evidence and attempt lineage. A timeout flag or nonzero exit alone does not
 * override an accepted semantic result. In particular, workspace copy-back,
 * approval, budget, and cancellation failures must never replay provider work.
 *
 * Scheduling and execution remain the caller's responsibility: persist the
 * secondary attempt atomically before dispatch and recheck normal admission.
 */
export function decideSecondaryAdapterFallback(input: {
  configured: boolean;
  alreadyAttempted: boolean;
  cancelled: boolean;
  completed: boolean;
  providerStopped: boolean;
  failureReason: SecondaryAdapterFailureReason | null;
}): SecondaryAdapterFallbackDecision {
  if (!input.configured) return { fallback: false, reason: "not_configured" };
  if (input.alreadyAttempted) return { fallback: false, reason: "already_attempted" };
  if (input.cancelled) return { fallback: false, reason: "cancelled" };
  if (input.completed) return { fallback: false, reason: "completed" };
  if (!input.providerStopped) return { fallback: false, reason: "provider_still_running" };
  if (!input.failureReason) return { fallback: false, reason: "not_execution_failure" };
  return { fallback: true, reason: input.failureReason };
}
