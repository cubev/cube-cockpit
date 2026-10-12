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

/** Classify adapter-owned failures, never diagnostic prose from setup/cleanup. */
export function secondaryAdapterFailureReason(input: {
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  errorCode?: string | null;
  errorFamily?: string | null;
  errorMessage?: string | null;
}): SecondaryAdapterFailureReason | null {
  if (input.timedOut) return "timeout";
  if (input.errorFamily === "model_refusal") return null;
  if (input.errorFamily === "provider_quota") return "quota";
  if (input.errorFamily === "transient_upstream") return "provider";
  if (input.errorFamily?.startsWith("refresh_token_")) return "authentication";
  // These are adapter codes, not arbitrary message substring matches.
  switch (input.errorCode) {
    case "timeout":
    case "acpx_timeout":
    case "acpx_handshake_timeout": return "timeout";
    case "rate_limit": return "rate_limit";
    case "quota_exceeded": return "quota";
    case "authentication_failed":
    case "login_required":
    case "acpx_auth_required":
    case "claude_auth_required":
    case "codex_auth_required": return "authentication";
    case "network_error": return "network";
    case "provider_error":
    case "acpx_runtime_error":
    case "acpx_handshake_transport_lost": return "provider";
    case "adapter_engine_unavailable":
    case "claude_cli_version_incompatible": return "adapter_failure";
  }
  if (input.errorCode && !["adapter_failed", "process_failed"].includes(input.errorCode)) return null;
  return input.errorMessage || input.signal || (input.exitCode != null && input.exitCode !== 0)
    ? "adapter_failure" : null;
}
