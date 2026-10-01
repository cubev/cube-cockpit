import { describe, expect, it } from "vitest";
import { createAgentHireSchema, createAgentSchema, updateAgentSchema } from "./agent.js";

describe("optional secondary adapter configuration", () => {
  it.each([createAgentSchema, createAgentHireSchema])("does not configure a secondary adapter when omitted", schema => {
    const parsed = schema.parse({ name: "Fixture", adapterType: "codex_local" });
    expect(parsed).not.toHaveProperty("secondaryAdapterType");
    expect(parsed).not.toHaveProperty("secondaryAdapterConfig");
  });

  it("does not enable a default adapter in an unrelated patch", () => {
    expect(updateAgentSchema.parse({ name: "Renamed" })).not.toHaveProperty("secondaryAdapterType");
  });

  it("preserves explicit secondary disable and selected types", () => {
    expect(createAgentSchema.parse({ name: "Fixture", secondaryAdapterType: null }).secondaryAdapterType).toBeNull();
    expect(createAgentSchema.parse({ name: "Fixture", secondaryAdapterType: "claude_local" }).secondaryAdapterType).toBe("claude_local");
  });
});
