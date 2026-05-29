import {
  sanitizeLinkReference,
  type BrowserToolResult,
  type MemoryRecord,
  type PageSnapshot,
  type PageTable,
  type ProviderConfig,
  type TaskContinuation,
  type TaskRun
} from "@open-agent-browser/shared";
import { generateProviderMessage, type ProviderGenerationOptions } from "./provider.js";

export function buildTaskContinuation(task: TaskRun): TaskContinuation | undefined {
  if (task.status !== "completed") {
    return undefined;
  }

  if (isPricingJsonIntent(task.message)) {
    const snapshotPrices = latestSnapshotPrices(task);
    if (snapshotPrices.length > 0) {
      return {
        message: JSON.stringify({
          prices: snapshotPrices
        }, null, 2)
      };
    }

    const text = latestExtractedText(task);
    if (!text) {
      return undefined;
    }

    return {
      message: JSON.stringify({
        prices: parsePricingEntries(text)
      }, null, 2)
    };
  }

  if (isLinkIntent(task.message)) {
    const links = latestExtractedLinks(task);
    if (links.length === 0) {
      return undefined;
    }

    return {
      message: JSON.stringify({
        links
      }, null, 2)
    };
  }

  if (isTabListIntent(task.message)) {
    const tabs = latestListedTabs(task);
    if (tabs.length === 0) {
      return undefined;
    }

    return {
      message: JSON.stringify({
        tabs
      }, null, 2)
    };
  }

  return undefined;
}

export async function buildProviderTaskContinuation(
  task: TaskRun,
  providerConfig: ProviderConfig,
  memories: MemoryRecord[] = [],
  options: ProviderGenerationOptions = {}
): Promise<TaskContinuation | undefined> {
  if (task.status !== "completed" || providerConfig.type === "disabled") {
    return undefined;
  }

  try {
    const message = await generateProviderMessage(
      providerConfig,
      {
        memories,
        plan: task.plan,
        request: {
          contextPolicy: "interactive-elements",
          message: [
            "Continue this browser task after the latest tool result.",
            `Original user task: ${task.message}`,
            "Return plain text if the task is done.",
            "Return JSON with message and toolCalls if another browser action is needed."
          ].join("\n"),
          pageSnapshot: {
            capturedAt: new Date().toISOString(),
            elements: [],
            headings: [],
            links: [],
            tables: [],
            text: formatTaskObservation(task),
            title: "Task Tool Results",
            url: "about:blank"
          }
        }
      },
      options
    );

    return message ? { message } : undefined;
  } catch {
    return undefined;
  }
}

function isPricingJsonIntent(message: string): boolean {
  const wantsStructuredOutput = /(json|structured|结构化|構造化)/i.test(message);
  const wantsPricing = /(price|pricing|plan|価格|料金|价格|定价)/i.test(message);
  return wantsStructuredOutput && wantsPricing;
}

function isLinkIntent(message: string): boolean {
  return /(links?|リンク|链接|連結)/i.test(message);
}

function isTabListIntent(message: string): boolean {
  return /(\b(list|show|what|which)\b.*\b(open\s+)?tabs?\b|\b(open\s+)?tabs?\b.*\b(list|open|available)\b|标签页|標籤頁|タブ一覧|開いているタブ)/i
    .test(message);
}

function latestExtractedText(task: TaskRun): string | undefined {
  for (const record of [...task.results].reverse()) {
    const result = record.result as BrowserToolResult;
    const payload = result.result;
    if (result.status === "completed" && result.toolName === "extractText" && isRecord(payload)) {
      const text = payload.text;
      if (typeof text === "string" && text.trim()) {
        return text;
      }
    }
  }

  return undefined;
}

function latestSnapshotPrices(task: TaskRun): Array<{ name: string; price: string; sourceText: string }> {
  for (const record of [...task.results].reverse()) {
    const result = record.result as BrowserToolResult;
    const payload = result.result;
    if (result.status !== "completed" || result.toolName !== "getPageSnapshot" || !isPageSnapshotLike(payload)) {
      continue;
    }

    const tablePrices = (payload.tables ?? []).flatMap(parsePricingTable);
    if (tablePrices.length > 0) {
      return uniquePricingEntries(tablePrices);
    }

    const textPrices = parsePricingEntries(payload.text ?? "");
    if (textPrices.length > 0) {
      return textPrices;
    }
  }

  return [];
}

function isPageSnapshotLike(value: unknown): value is PageSnapshot {
  return isRecord(value) &&
    typeof value.text === "string" &&
    Array.isArray(value.elements) &&
    Array.isArray(value.links);
}

function latestExtractedLinks(task: TaskRun): Array<{ href: string; text: string }> {
  for (const record of [...task.results].reverse()) {
    const result = record.result as BrowserToolResult;
    const payload = result.result;
    if (result.status !== "completed" || result.toolName !== "extractLinks" || !isRecord(payload)) {
      continue;
    }

    const links = Array.isArray(payload.links) ? payload.links : [];
    return uniqueLinks(links.flatMap((link) => {
      if (!isRecord(link) || typeof link.href !== "string") {
        return [];
      }

      return [sanitizeLinkReference({
        href: compactWhitespace(link.href).slice(0, 2000),
        text: typeof link.text === "string" ? compactWhitespace(link.text).slice(0, 500) : ""
      })];
    }));
  }

  return [];
}

function latestListedTabs(task: TaskRun): Array<{
  active: boolean;
  id: number;
  index: number;
  title: string;
  url: string;
  windowId: number;
}> {
  for (const record of [...task.results].reverse()) {
    const result = record.result as BrowserToolResult;
    const payload = result.result;
    if (result.status !== "completed" || result.toolName !== "listTabs" || !isRecord(payload)) {
      continue;
    }

    const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
    return tabs.flatMap((tab) => {
      if (!isRecord(tab) ||
        typeof tab.id !== "number" ||
        typeof tab.index !== "number" ||
        typeof tab.windowId !== "number") {
        return [];
      }

      return [{
        active: Boolean(tab.active),
        id: tab.id,
        index: tab.index,
        title: typeof tab.title === "string" ? compactWhitespace(tab.title).slice(0, 500) : "",
        url: typeof tab.url === "string" ? compactWhitespace(tab.url).slice(0, 2000) : "",
        windowId: tab.windowId
      }];
    }).slice(0, 200);
  }

  return [];
}

function parsePricingTable(table: PageTable): Array<{ name: string; price: string; sourceText: string }> {
  const headers = table.headers.map((header) => compactWhitespace(header).toLowerCase());
  const nameIndex = findHeaderIndex(headers, /(plan|name|tier|package|feature|プラン|名前|名称|方案)/i) ?? 0;
  const priceIndex = findHeaderIndex(headers, /(price|pricing|cost|amount|fee|料金|価格|价格|定价)/i) ??
    findFirstPriceColumn(table.rows);

  if (priceIndex === undefined) {
    return [];
  }

  return table.rows.flatMap((row) => {
    const name = compactWhitespace(row[nameIndex] ?? "");
    const price = compactWhitespace(row[priceIndex] ?? "");
    if (!name || !price || !isPriceLike(price)) {
      return [];
    }

    return [{
      name,
      price,
      sourceText: row.map(compactWhitespace).filter(Boolean).join(" | ")
    }];
  });
}

function findHeaderIndex(headers: string[], pattern: RegExp): number | undefined {
  const index = headers.findIndex((header) => pattern.test(header));
  return index >= 0 ? index : undefined;
}

function findFirstPriceColumn(rows: string[][]): number | undefined {
  const columnScores = new Map<number, number>();

  for (const row of rows) {
    row.forEach((cell, index) => {
      if (isPriceLike(cell)) {
        columnScores.set(index, (columnScores.get(index) ?? 0) + 1);
      }
    });
  }

  return [...columnScores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

function isPriceLike(value: string): boolean {
  return /([$€£¥]\s?\d+(?:[.,]\d+)?(?:\s?\/\s?\w+)?|\d+(?:[.,]\d+)?\s?(?:USD|EUR|JPY|円)(?:\s?\/\s?\w+)?|contact\s+us|custom|お問い合わせ|相談)/i
    .test(value);
}

function uniqueLinks(links: Array<{ href: string; text: string }>): Array<{ href: string; text: string }> {
  const seen = new Set<string>();
  const unique: Array<{ href: string; text: string }> = [];

  for (const link of links) {
    const key = `${link.href}\n${link.text}`;
    if (!link.href || seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(link);
  }

  return unique.slice(0, 200);
}

function uniquePricingEntries(
  entries: Array<{ name: string; price: string; sourceText: string }>
): Array<{ name: string; price: string; sourceText: string }> {
  const seen = new Set<string>();
  const unique: Array<{ name: string; price: string; sourceText: string }> = [];

  for (const entry of entries) {
    const key = `${entry.name}\n${entry.price}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

function parsePricingEntries(text: string): Array<{ name: string; price: string; sourceText: string }> {
  const lines = text.split(/\r?\n/).map((line) => compactWhitespace(line)).filter(Boolean);
  const entries: Array<{ name: string; price: string; sourceText: string }> = [];
  const pricePattern = /([$€£¥]\s?\d+(?:[.,]\d+)?(?:\s?\/\s?\w+)?|\d+(?:[.,]\d+)?\s?(?:USD|EUR|JPY|円)(?:\s?\/\s?\w+)?)/i;
  const contactPattern = /(contact\s+us|custom|お問い合わせ|相談)/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const priceMatch = line.match(pricePattern);
    const contactMatch = line.match(contactPattern);
    const match = priceMatch ?? contactMatch;

    if (!match || typeof match.index !== "number") {
      continue;
    }

    const before = line.slice(0, match.index).replace(/[-:|]+$/, "").trim();
    const after = line.slice(match.index + match[0].length).replace(/^[-:|]+/, "").trim();
    const fallbackName = index > 0 ? lines[index - 1]! : "Plan";
    const name = before || fallbackName;
    const price = contactMatch ? match[0] : [match[0], after].filter(Boolean).join(" ");

    if (!entries.some((entry) => entry.name === name && entry.price === price)) {
      entries.push({
        name,
        price,
        sourceText: line
      });
    }
  }

  return entries;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatTaskObservation(task: TaskRun): string {
  const latestResults = task.results.slice(-6).map((record) => {
    const result = record.result as BrowserToolResult;
    return [
      `Tool: ${result.toolName}`,
      `Status: ${result.status}`,
      `Result: ${compactWhitespace(JSON.stringify(result.result ?? result.error ?? ""))}`
    ].join("\n");
  });

  return [
    `Task ID: ${task.taskId}`,
    `Task status: ${task.status}`,
    `Original task: ${task.message}`,
    "Recent tool observations:",
    latestResults.join("\n\n") || "(none)"
  ].join("\n").slice(0, 8000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
