import { describe, expect, it } from "vitest";
import { commandIds, createCommandDraftMessage } from "./commandDraft.js";

describe("command draft messages", () => {
  it("creates a current-page summary draft for the summarize command", () => {
    expect(createCommandDraftMessage({
      command: commandIds.summarizePage,
      pageUrl: "https://example.test/docs"
    })).toBe("Summarize this page and extract the key links: https://example.test/docs");
  });

  it("returns no draft for the open panel command", () => {
    expect(createCommandDraftMessage({
      command: commandIds.openPanel,
      pageUrl: "https://example.test/docs"
    })).toBeUndefined();
  });
});
