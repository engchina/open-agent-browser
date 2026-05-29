import { describe, expect, it } from "vitest";
import { ApprovalRegistry } from "./approval.js";

describe("approval risk classification", () => {
  it("marks ordinary clicks as medium risk while still requiring approval", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create({
      args: {
        description: "Open details",
        selector: "button.details"
      },
      id: "click-ordinary",
      toolName: "click"
    });

    expect(request.risk).toBe("medium");
    expect(request.reason).toContain("Click actions");
  });

  it("marks sensitive clicks as high risk", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create({
      args: {
        description: "Delete account",
        selector: "button.delete-account"
      },
      id: "click-delete",
      toolName: "click"
    });

    expect(request.risk).toBe("high");
    expect(request.reason).toContain("sensitive page action");
  });

  it("keeps local safety reasons before provider-supplied notes", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create(
      {
        args: {
          description: "Delete account",
          selector: "button.delete-account"
        },
        id: "click-provider-delete",
        toolName: "click"
      },
      "This is only a harmless cleanup.",
      { reasonSource: "provider" }
    );

    expect(request.risk).toBe("high");
    expect(request.reason).toContain("sensitive page action");
    expect(request.reason).toContain("Provider note: This is only a harmless cleanup.");
  });

  it("keeps locally supplied approval reasons as the primary reason", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create(
      {
        args: {
          selector: "button.submit"
        },
        id: "click-local-reason",
        toolName: "click"
      },
      "The task may submit a form. Review the target button before execution."
    );

    expect(request.reason).toBe("The task may submit a form. Review the target button before execution.");
  });

  it("marks sensitive navigation paths as high risk", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create({
      args: {
        url: "https://example.com/checkout/payment"
      },
      id: "navigate-payment",
      toolName: "navigate"
    });

    expect(request.risk).toBe("high");
    expect(request.reason).toContain("payment");
  });

  it("marks cross-origin navigation as high risk when source context is available", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create({
      args: {
        sourceUrl: "https://example.com/docs",
        url: "https://other.example/pricing"
      },
      id: "navigate-cross-origin",
      toolName: "navigate"
    });

    expect(request.risk).toBe("high");
    expect(request.reason).toContain("leaves the current site");
  });

  it("keeps same-origin navigation without sensitive paths at medium risk", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create({
      args: {
        sourceUrl: "https://example.com/docs",
        url: "https://example.com/pricing"
      },
      id: "navigate-same-origin",
      toolName: "navigate"
    });

    expect(request.risk).toBe("medium");
  });

  it("keeps approval tokens bound to the reviewed action after risk classification", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create({
      args: {
        description: "Download invoice",
        selector: "a.download"
      },
      id: "click-download",
      toolName: "click"
    });

    expect(request.risk).toBe("high");
    expect(registry.consume(request.token, request.toolCall)?.id).toBe(request.id);
    expect(registry.consume(request.token, request.toolCall)).toBeUndefined();
  });

  it("can inspect an approval without consuming its token", () => {
    const registry = new ApprovalRegistry();
    const request = registry.create({
      args: {
        selector: "button.submit"
      },
      id: "click-submit",
      toolName: "click"
    });

    expect(registry.get(request.token, request.id)?.toolCall.id).toBe("click-submit");
    expect(registry.consume(request.token, request.toolCall)?.id).toBe(request.id);
  });

  it("adds an expiry timestamp to approval requests", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const registry = new ApprovalRegistry({
      now: () => now,
      ttlMs: 60_000
    });
    const request = registry.create({
      args: {
        selector: "button.submit"
      },
      id: "click-expiring",
      toolName: "click"
    });

    expect(request.expiresAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it("rejects expired approval tokens before consuming actions", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const registry = new ApprovalRegistry({
      now: () => now,
      ttlMs: 1_000
    });
    const request = registry.create({
      args: {
        selector: "button.submit"
      },
      id: "click-expired",
      toolName: "click"
    });

    now += 1_001;

    expect(registry.get(request.token, request.id)).toBeUndefined();
    expect(registry.reject(request.token, request.id)).toBeUndefined();
    expect(registry.consume(request.token, request.toolCall)).toBeUndefined();
  });

  it("revokes approvals by planned tool call ID", () => {
    const registry = new ApprovalRegistry();
    const keep = registry.create({
      args: {
        selector: "button.keep"
      },
      id: "click-keep",
      toolName: "click"
    });
    const revoke = registry.create({
      args: {
        selector: "button.revoke"
      },
      id: "click-revoke",
      toolName: "click"
    });

    expect(registry.revokeByToolCallIds(["click-revoke"])).toBe(1);
    expect(registry.consume(revoke.token, revoke.toolCall)).toBeUndefined();
    expect(registry.consume(keep.token, keep.toolCall)?.id).toBe(keep.id);
  });

  it("does not count expired approvals as revoked", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const registry = new ApprovalRegistry({
      now: () => now,
      ttlMs: 1_000
    });
    const expired = registry.create({
      args: {
        selector: "button.expired"
      },
      id: "click-expired-revoke",
      toolName: "click"
    });

    now += 1_001;

    expect(registry.revokeByToolCallIds([expired.toolCall.id])).toBe(0);
  });
});
