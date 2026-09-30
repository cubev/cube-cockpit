import { secondaryAdapterFailureReason } from "../services/secondary-adapter-fallback.js";
import { describe, expect, it } from "vitest";
import {
  decideSecondaryAdapterFallback,
  type SecondaryAdapterFailureReason,
} from "../services/secondary-adapter-fallback.js";

const primaryFailure = {
  configured: true,
  alreadyAttempted: false,
  cancelled: false,
  completed: false,
  providerStopped: true,
  failureReason: "adapter_failure" as SecondaryAdapterFailureReason,
};

describe("secondary adapter fallback decision", () => {
  it.each<SecondaryAdapterFailureReason>([
    "adapter_failure", "authentication", "quota", "rate_limit", "provider", "network", "timeout",
  ])("permits one secondary attempt for an unfinished %s failure", (failureReason) => {
    expect(decideSecondaryAdapterFallback({ ...primaryFailure, failureReason }))
      .toEqual({ fallback: true, reason: failureReason });
  });

  it("preserves existing behavior when no secondary is configured", () => {
    expect(decideSecondaryAdapterFallback({ ...primaryFailure, configured: false }))
      .toEqual({ fallback: false, reason: "not_configured" });
  });

  it("never switches after the secondary attempt fails", () => {
    expect(decideSecondaryAdapterFallback({ ...primaryFailure, alreadyAttempted: true }))
      .toEqual({ fallback: false, reason: "already_attempted" });
  });

  it("does not repeat successful work", () => {
    expect(decideSecondaryAdapterFallback({ ...primaryFailure, completed: true, failureReason: null }))
      .toEqual({ fallback: false, reason: "completed" });
  });

  it("does not repeat accepted work when teardown times out", () => {
    expect(decideSecondaryAdapterFallback({ ...primaryFailure, completed: true, failureReason: "timeout" }))
      .toEqual({ fallback: false, reason: "completed" });
  });

  it("respects an operator stop even when the process reports failure", () => {
    expect(decideSecondaryAdapterFallback({ ...primaryFailure, cancelled: true }))
      .toEqual({ fallback: false, reason: "cancelled" });
  });

  it("does not switch for control-plane or workspace failures", () => {
    expect(decideSecondaryAdapterFallback({ ...primaryFailure, failureReason: null }))
      .toEqual({ fallback: false, reason: "not_execution_failure" });
  });

  it("waits for confirmed provider shutdown before another provider starts", () => {
    expect(decideSecondaryAdapterFallback({ ...primaryFailure, providerStopped: false }))
      .toEqual({ fallback: false, reason: "provider_still_running" });
  });
});


describe("adapter failure classification", () => {
  it.each([
    [{ errorFamily: "provider_quota" }, "quota"],
    [{ errorFamily: "transient_upstream" }, "provider"],
    [{ errorCode: "acpx_auth_required" }, "authentication"],
    [{ errorCode: "acpx_handshake_timeout" }, "timeout"],
    [{ errorCode: "rate_limit" }, "rate_limit"],
    [{ errorCode: "network_error" }, "network"],
    [{ exitCode: 1 }, "adapter_failure"],
    [{ exitCode: 0 }, null],
    [{ errorFamily: "model_refusal", exitCode: 1 }, null],
    [{ errorCode: "workspace_sync_out_failed", exitCode: 1 }, null],
    [{ errorCode: "budget_exceeded", exitCode: 1 }, null],
    [{ errorCode: "cancelled", exitCode: 1 }, null],
  ])("classifies only execution evidence %j", (input, expected) => {
    expect(secondaryAdapterFailureReason(input)).toBe(expected);
  });
});
