import { describe, expect, it } from "vitest";
import { contextMenuIds, createContextMenuDraftMessage } from "./contextMenuDraft.js";

describe("context menu draft messages", () => {
  it("creates a bounded selected-text task", () => {
    const message = createContextMenuDraftMessage({
      menuItemId: contextMenuIds.selection,
      pageUrl: "https://example.test/article",
      selectionText: `  ${"selected text ".repeat(220)}  `
    });

    expect(message).toMatch(/^Summarize this selected text on https:\/\/example\.test\/article:/);
    expect(message?.length).toBeLessThanOrEqual(2070);
    expect(message?.endsWith("...")).toBe(true);
  });

  it("creates a link task with source page context", () => {
    const message = createContextMenuDraftMessage({
      linkUrl: "https://example.test/pricing",
      menuItemId: contextMenuIds.link,
      pageUrl: "https://example.test/home"
    });

    expect(message).toBe(
      "Open this link from https://example.test/home, summarize it, and extract the key links: https://example.test/pricing"
    );
  });

  it("creates a page task and ignores unknown menu IDs", () => {
    expect(createContextMenuDraftMessage({
      menuItemId: contextMenuIds.page,
      pageUrl: "https://example.test/docs"
    })).toBe("Summarize this page and extract the key links: https://example.test/docs");

    expect(createContextMenuDraftMessage({
      menuItemId: "unknown"
    })).toBeUndefined();
  });
});
