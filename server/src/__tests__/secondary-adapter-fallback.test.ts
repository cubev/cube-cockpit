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
