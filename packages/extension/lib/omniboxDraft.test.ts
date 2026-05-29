import { describe, expect, it } from "vitest";
import { createOmniboxDraftMessage } from "./omniboxDraft.js";

describe("omnibox draft messages", () => {
  it("creates a current-page task when input is empty", () => {
    expect(createOmniboxDraftMessage({
      pageUrl: "https://example.test/docs",
      text: "   "
    })).toBe("Summarize this page and extract the key links: https://example.test/docs");
  });

  it("creates a URL navigation task for HTTP URLs", () => {
    expect(createOmniboxDraftMessage({
      pageUrl: "https://example.test/current",
      text: "https://example.test/pricing"
    })).toBe("Open this URL, summarize it, and extract the key links: https://example.test/pricing");
  });

  it("creates a bounded browser task for natural language input", () => {
    const message = createOmniboxDraftMessage({
      pageUrl: "https://example.test/current",
      text: `  ${"compare plans ".repeat(120)}  `
    });

    expect(message).toMatch(/^Answer this browser task for the current page https:\/\/example\.test\/current:/);
    expect(message.length).toBeLessThanOrEqual(1085);
    expect(message.endsWith("...")).toBe(true);
  });
});
