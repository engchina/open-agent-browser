import {
  sanitizeLinkReference,
  sanitizePageSnapshot,
  validateToolArgs,
  type BrowserToolCall,
  type BrowserToolResult,
  type PageSnapshot
} from "@open-agent-browser/shared";

type ScriptExecutionResult<T> = chrome.scripting.InjectionResult<T>[];

interface PageSnapshotCaptureOptions {
  includeInputs?: boolean;
  includeLinks?: boolean;
  maxElements?: number;
  maxTextLength?: number;
}

interface InPageSnapshotCaptureOptions {
  includeInputs: boolean;
  includeLinks: boolean;
}

interface PageCaptureMetrics {
  devicePixelRatio: number;
  fullHeight: number;
  fullWidth: number;
  scrollX: number;
  scrollY: number;
  viewportHeight: number;
  viewportWidth: number;
}

interface ScreenshotTile {
  dataUrl: string;
  x: number;
  y: number;
}

export async function executeBrowserTool(call: BrowserToolCall): Promise<BrowserToolResult> {
  const args = validateToolArgs(call.toolName, call.args);
  const tabId = call.tabId ?? await getActiveTabId();

  switch (call.toolName) {
    case "navigate": {
      const url = String(args.url);
      const waitForNavigation = waitForTabComplete(tabId, url);
      await chrome.tabs.update(tabId, {
        url
      });
      await waitForNavigation;
      return completed(call, { tabId });
    }
    case "getPageSnapshot": {
      const snapshot = await getPageSnapshot(tabId, {
        includeInputs: Boolean(args.includeInputs),
        includeLinks: Boolean(args.includeLinks)
      });
      return completed(call, snapshot);
    }
    case "listTabs": {
      const tabs = await chrome.tabs.query({
        currentWindow: Boolean(args.currentWindow)
      });
      return completed(call, { tabs: tabs.map(summarizeTab) });
    }
    case "activateTab": {
      const targetTabId = Number(args.tabId);
      const targetWindowId = typeof args.windowId === "number" ? Number(args.windowId) : undefined;
      const tab = await chrome.tabs.update(targetTabId, { active: true });
      const windowId = targetWindowId ?? tab?.windowId;
      if (typeof windowId === "number") {
        await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
      }

      return completed(call, {
        ...(tab ? summarizeTab(tab) : {}),
        id: tab?.id ?? targetTabId,
        windowId
      });
    }
    case "openTab": {
      const tab = await chrome.tabs.create({
        active: Boolean(args.active),
        url: String(args.url)
      });
      return completed(call, summarizeTab(tab));
    }
    case "closeTab": {
      const targetTabId = Number(args.tabId);
      await chrome.tabs.remove(targetTabId);
      return completed(call, {
        closed: true,
        tabId: targetTabId,
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.url === "string" ? { url: args.url } : {}),
        ...(typeof args.windowId === "number" ? { windowId: args.windowId } : {})
      });
    }
    case "downloadUrl": {
      const downloadId = await downloadFile({
        conflictAction: String(args.conflictAction) as chrome.downloads.FilenameConflictAction,
        ...(typeof args.filename === "string" ? { filename: args.filename } : {}),
        saveAs: Boolean(args.saveAs),
        url: String(args.url)
      });
      const item = await findDownload(downloadId);
      return completed(call, {
        downloadId,
        filename: item?.filename,
        mime: item?.mime,
        state: item?.state,
        url: args.url
      });
    }
    case "extractText": {
      const selector = typeof args.selector === "string" ? args.selector : null;
      const result = firstResult(await executeInTab(tabId, extractTextFromPage, [selector]));
      return completed(call, { text: result ?? "" });
    }
    case "extractLinks": {
      const selector = typeof args.selector === "string" ? args.selector : null;
      const result = firstResult(await executeInTab(tabId, extractLinksFromPage, [selector]));
      return completed(call, { links: (result ?? []).map(sanitizeLinkReference) });
    }
    case "scroll": {
      const result = firstResult(await executeInTab(tabId, scrollPage, [String(args.direction), Number(args.amount)]));
      if (!isActionResult(result, "scrolled")) {
        throw new Error("Scroll did not complete.");
      }
      return completed(call, { tabId });
    }
    case "click": {
      const selector = String(args.selector);
      await assertExpectedTabUrl(tabId, args.expectedUrl);
      const result = firstResult(await executeInTab(tabId, clickSelector, [selector]));
      if (!isActionResult(result, "clicked")) {
        throw new Error(readActionError(result, `Click did not complete: ${selector}`));
      }
      return completed(call, { tabId });
    }
    case "type": {
      const selector = String(args.selector);
      await assertExpectedTabUrl(tabId, args.expectedUrl);
      const result = firstResult(await executeInTab(tabId, typeIntoSelector, [
        selector,
        String(args.text),
        Boolean(args.clearFirst)
      ]));
      if (!isActionResult(result, "typed")) {
        throw new Error(readActionError(result, `Typing did not complete: ${selector}`));
      }
      return completed(call, { tabId });
    }
    case "press": {
      const key = String(args.key);
      await assertExpectedTabUrl(tabId, args.expectedUrl);
      const result = firstResult(await executeInTab(tabId, pressKey, [key]));
      if (!isActionResult(result, "pressed")) {
        throw new Error(`Key press did not complete: ${key}`);
      }
      return completed(call, { tabId });
    }
    case "screenshot": {
      const fullPage = Boolean(args.fullPage);
      const dataUrl = fullPage ? await captureFullPage(tabId) : await captureVisibleTab();
      return completed(call, { dataUrl, fullPage });
    }
  }
}

export async function getPageSnapshot(
  tabId?: number,
  options: PageSnapshotCaptureOptions = {}
): Promise<PageSnapshot> {
  const resolvedTabId = tabId ?? await getActiveTabId();
  const captureOptions = {
    includeInputs: options.includeInputs ?? true,
    includeLinks: options.includeLinks ?? true
  };
  const result = firstResult(await executeInTab(resolvedTabId, captureSnapshotFromPage, [resolvedTabId, captureOptions]));
  if (!result) {
    throw new Error("Page snapshot capture returned no result.");
  }

  return sanitizePageSnapshot(result, options);
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (typeof tab?.id !== "number") {
    throw new Error("No active tab is available.");
  }

  return tab.id;
}

async function assertExpectedTabUrl(tabId: number, expectedUrl: unknown): Promise<void> {
  if (typeof expectedUrl !== "string" || expectedUrl.length === 0) {
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  const actualUrl = tab.url ?? "";
  if (!urlsMatch(actualUrl, expectedUrl)) {
    throw new Error(`Page changed after approval: expected ${expectedUrl}, got ${actualUrl || "unknown"}`);
  }
}

async function executeInTab<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args
): Promise<ScriptExecutionResult<Awaited<Result>>> {
  const results = await chrome.scripting.executeScript({
    args,
    func,
    target: {
      tabId
    }
  });

  throwOnScriptExecutionError(results);

  return results as unknown as ScriptExecutionResult<Awaited<Result>>;
}

function firstResult<Result>(results: ScriptExecutionResult<Result>): Result | undefined {
  return results[0]?.result;
}

function throwOnScriptExecutionError(results: chrome.scripting.InjectionResult<unknown>[]): void {
  const failed = results.find((result) => {
    const candidate = result as { error?: unknown };
    return candidate.error !== undefined;
  }) as { error?: unknown } | undefined;

  if (!failed) {
    return;
  }

  const error = failed.error;
  if (typeof error === "string" && error.trim()) {
    throw new Error(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    throw new Error(String((error as { message: unknown }).message));
  }

  throw new Error("Injected browser script failed.");
}

function isActionResult(value: unknown, key: "clicked" | "pressed" | "scrolled" | "typed"): boolean {
  return typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[key] === true;
}

function readActionError(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).error === "string") {
    return (value as { error: string }).error;
  }

  return fallback;
}

function captureVisibleTab(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab({ format: "png" }, (dataUrl) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(dataUrl);
      }
    });
  });
}

function downloadFile(options: chrome.downloads.DownloadOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (typeof downloadId !== "number") {
        reject(new Error("Download did not return an ID."));
        return;
      }

      resolve(downloadId);
    });
  });
}

function findDownload(downloadId: number): Promise<chrome.downloads.DownloadItem | undefined> {
  return new Promise((resolve, reject) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(items[0]);
    });
  });
}

async function captureFullPage(tabId: number): Promise<string> {
  const metrics = firstResult(await executeInTab(tabId, readPageCaptureMetrics, []));
  if (!metrics) {
    throw new Error("Full-page screenshot metrics returned no result.");
  }

  if (metrics.fullHeight <= metrics.viewportHeight && metrics.fullWidth <= metrics.viewportWidth) {
    return await captureVisibleTab();
  }

  const tiles: ScreenshotTile[] = [];
  const xPositions = capturePositions(metrics.fullWidth, metrics.viewportWidth);
  const yPositions = capturePositions(metrics.fullHeight, metrics.viewportHeight);

  try {
    for (const y of yPositions) {
      for (const x of xPositions) {
        await executeInTab(tabId, scrollToCapturePosition, [x, y]);
        tiles.push({
          dataUrl: await captureVisibleTab(),
          x,
          y
        });
      }
    }
  } finally {
    await executeInTab(tabId, scrollToCapturePosition, [metrics.scrollX, metrics.scrollY]).catch(() => undefined);
  }

  return await stitchScreenshotTiles(tiles, metrics);
}

function capturePositions(total: number, viewport: number): number[] {
  if (total <= viewport) {
    return [0];
  }

  const positions: number[] = [];
  for (let position = 0; position < total; position += viewport) {
    positions.push(Math.min(position, total - viewport));
  }

  return [...new Set(positions)];
}

async function stitchScreenshotTiles(tiles: ScreenshotTile[], metrics: PageCaptureMetrics): Promise<string> {
  const scale = Math.max(1, metrics.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(metrics.fullWidth * scale);
  canvas.height = Math.ceil(metrics.fullHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create screenshot canvas context.");
  }

  for (const tile of tiles) {
    const image = await loadImage(tile.dataUrl);
    context.drawImage(image, Math.round(tile.x * scale), Math.round(tile.y * scale));
  }

  return canvas.toDataURL("image/png");
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to decode screenshot tile."));
    image.src = dataUrl;
  });
}

function waitForTabComplete(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out waiting for navigation to complete: ${url}`));
    }, 15000);

    const listener = (updatedTabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      if (tab.url && !urlsMatch(tab.url, url)) {
        return;
      }

      window.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function urlsMatch(actual: string, expected: string): boolean {
  return normalizeUrl(actual) === normalizeUrl(expected);
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

function completed(call: BrowserToolCall, result: unknown): BrowserToolResult {
  return {
    result,
    status: "completed",
    toolName: call.toolName
  };
}

function summarizeTab(tab: chrome.tabs.Tab): Record<string, unknown> {
  return {
    active: Boolean(tab.active),
    id: tab.id,
    index: tab.index,
    title: tab.title ?? "",
    url: tab.url ?? "",
    windowId: tab.windowId
  };
}

function readPageCaptureMetrics(): PageCaptureMetrics {
  const documentElement = document.documentElement;
  const body = document.body;
  const fullWidth = Math.max(
    documentElement?.scrollWidth ?? 0,
    documentElement?.offsetWidth ?? 0,
    body?.scrollWidth ?? 0,
    body?.offsetWidth ?? 0,
    window.innerWidth
  );
  const fullHeight = Math.max(
    documentElement?.scrollHeight ?? 0,
    documentElement?.offsetHeight ?? 0,
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
    window.innerHeight
  );

  return {
    devicePixelRatio: window.devicePixelRatio || 1,
    fullHeight,
    fullWidth,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth
  };
}

function scrollToCapturePosition(x: number, y: number): Promise<void> {
  window.scrollTo(x, y);

  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function captureSnapshotFromPage(tabId: number, options: InPageSnapshotCaptureOptions): PageSnapshot {
  const includeInputs = options.includeInputs;
  const includeLinks = options.includeLinks;
  const escapeAttributeValue = (value: string): string => {
    return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  };
  const compactLabel = (value: string | null | undefined): string => {
    return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  };
  const textFromIds = (ids: string): string => {
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
      .map(compactLabel)
      .filter(Boolean)
      .join(" ");
  };
  const explicitLabelFor = (element: Element): string => {
    if (!element.id) {
      return "";
    }

    const label = document.querySelector(`label[for="${escapeAttributeValue(element.id)}"]`) as HTMLLabelElement | null;
    return compactLabel(label?.innerText || label?.textContent);
  };
  const accessibleLabelFor = (element: Element): string => {
    const ariaLabel = compactLabel(element.getAttribute("aria-label"));
    if (ariaLabel) {
      return ariaLabel;
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = compactLabel(textFromIds(labelledBy));
      if (label) {
        return label;
      }
    }

    const explicitLabel = explicitLabelFor(element);
    if (explicitLabel) {
      return explicitLabel;
    }

    const wrappingLabel = element.closest("label") as HTMLLabelElement | null;
    const wrappedLabel = compactLabel(wrappingLabel?.innerText || wrappingLabel?.textContent);
    if (wrappedLabel) {
      return wrappedLabel;
    }

    return compactLabel(
      element.getAttribute("title") ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder")
    );
  };
  const shouldIncludeElement = (element: Element): boolean => {
    const tagName = element.tagName.toLowerCase();

    if (!includeLinks && tagName === "a") {
      return false;
    }

    if (!includeInputs && ["input", "select", "textarea"].includes(tagName)) {
      return false;
    }

    return true;
  };
  const isElementVisible = (element: Element): boolean => {
    if (element.closest("[hidden], [aria-hidden=\"true\"], [inert]")) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }

    const rects = element.getClientRects();
    if (rects.length === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const localSelectorFor = (element: Element): string => {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    const name = element.getAttribute("name");
    if (name) {
      const candidate = `${element.tagName.toLowerCase()}[name="${escapeAttributeValue(name)}"]`;
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }

    const path: string[] = [];
    let current: Element | null = element;

    while (current && current !== document.documentElement) {
      const tagName = current.tagName.toLowerCase();
      if (current.id) {
        path.unshift(`#${CSS.escape(current.id)}`);
        break;
      }

      const parent: Element | null = current.parentElement;
      if (!parent) {
        path.unshift(tagName);
        break;
      }

      const siblings = Array.from(parent.children) as Element[];
      const sameTagSiblings = siblings.filter((sibling) =>
        sibling.tagName.toLowerCase() === tagName
      );
      const siblingIndex = sameTagSiblings.indexOf(current) + 1;
      path.unshift(`${tagName}:nth-of-type(${siblingIndex})`);

      const candidate = path.join(" > ");
      if (path.length > 1 && document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }

      current = parent;
    }

    return path.join(" > ") || element.tagName.toLowerCase();
  };

  const elements = Array.from(
    document.querySelectorAll("a, button, input, select, textarea, [role], [aria-label]")
  ).filter((element) => shouldIncludeElement(element) && isElementVisible(element)).slice(0, 250).map((element, index) => {
    const htmlElement = element as HTMLElement;
    const attributes: Record<string, string> = {};
    const accessibleLabel = accessibleLabelFor(element);

    for (const attribute of Array.from(element.attributes)) {
      const allowedAttributes = includeLinks
        ? ["aria-checked", "aria-disabled", "aria-label", "aria-labelledby", "aria-selected", "autocomplete", "checked", "disabled", "href", "name", "placeholder", "readonly", "role", "selected", "type", "value"]
        : ["aria-checked", "aria-disabled", "aria-label", "aria-labelledby", "aria-selected", "autocomplete", "checked", "disabled", "name", "placeholder", "readonly", "role", "selected", "type", "value"];
      if (allowedAttributes.includes(attribute.name)) {
        attributes[attribute.name] = attribute.value;
      }
    }

    if (accessibleLabel) {
      attributes.label = accessibleLabel;
    }

    const role = element.getAttribute("role");
    const pageElement = {
      attributes,
      selector: localSelectorFor(element),
      tagName: element.tagName.toLowerCase(),
      text: compactLabel(htmlElement.innerText || element.getAttribute("aria-label") || accessibleLabel)
    };

    return role ? { ...pageElement, role } : pageElement;
  });
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter(isElementVisible).slice(0, 100).flatMap((heading) => {
    const text = compactLabel((heading as HTMLElement).innerText || heading.textContent);
    if (!text) {
      return [];
    }

    return [{
      level: Number(heading.tagName.slice(1)),
      selector: localSelectorFor(heading),
      text
    }];
  });

  const links = includeLinks ? Array.from(document.querySelectorAll("a[href]")).filter(isElementVisible).slice(0, 500).map((link) => {
    const anchor = link as HTMLAnchorElement;
    return {
      href: anchor.href,
      text: anchor.innerText.trim()
    };
  }) : [];
  const cellText = (cell: Element): string => compactLabel((cell as HTMLElement).innerText || cell.textContent);
  const tables = Array.from(document.querySelectorAll("table")).filter(isElementVisible).slice(0, 20).flatMap((table) => {
    const headerCells = Array.from(table.querySelectorAll("thead th"));
    const fallbackHeaderCells = headerCells.length > 0
      ? []
      : Array.from(table.querySelectorAll("tr:first-child th"));
    const headers = [...headerCells, ...fallbackHeaderCells].slice(0, 20).map(cellText).filter(Boolean);
    const rows = Array.from(table.querySelectorAll("tbody tr, tr")).slice(0, 50).flatMap((row) => {
      const cells = Array.from(row.querySelectorAll("td")).slice(0, 20).map(cellText);
      return cells.some(Boolean) ? [cells] : [];
    });

    if (headers.length === 0 && rows.length === 0) {
      return [];
    }

    const caption = compactLabel(table.querySelector("caption")?.textContent);
    const snapshotTable = {
      ...(caption ? { caption } : {}),
      headers,
      rows,
      selector: localSelectorFor(table)
    };

    return [snapshotTable];
  });

  return {
    capturedAt: new Date().toISOString(),
    elements,
    headings,
    links,
    tables,
    tabId,
    text: document.body?.innerText ?? "",
    title: document.title,
    url: location.href
  };
}

function extractTextFromPage(selector: string | null): string {
  const target = selector ? document.querySelector(selector) : document.body;
  return (target as HTMLElement | null)?.innerText ?? "";
}

function extractLinksFromPage(selector: string | null): Array<{ href: string; text: string }> {
  const target = selector ? document.querySelector(selector) : document;
  return Array.from(target?.querySelectorAll("a[href]") ?? []).map((link) => {
    const anchor = link as HTMLAnchorElement;
    return {
      href: anchor.href,
      text: anchor.innerText.trim()
    };
  });
}

function scrollPage(direction: string, amount: number): { scrolled: true } {
  const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
  window.scrollBy({
    behavior: "smooth",
    left: dx,
    top: dy
  });
  return { scrolled: true };
}

function clickSelector(selector: string): { clicked: true } | { clicked: false; error: string } {
  const element = document.querySelector(selector) as HTMLElement | null;
  const isElementVisible = (target: HTMLElement): boolean => {
    if (target.closest("[hidden], [aria-hidden=\"true\"], [inert]")) {
      return false;
    }

    const style = window.getComputedStyle(target);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }

    const rect = target.getBoundingClientRect();
    return target.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
  };
  const isDisabled = (target: HTMLElement): boolean =>
    target.matches(":disabled") || target.getAttribute("aria-disabled") === "true";

  if (!element) {
    return {
      clicked: false,
      error: `Element not found: ${selector}`
    };
  }
  if (!isElementVisible(element)) {
    return {
      clicked: false,
      error: `Element is not visible: ${selector}`
    };
  }
  if (isDisabled(element)) {
    return {
      clicked: false,
      error: `Element is disabled: ${selector}`
    };
  }
  element.click();
  return { clicked: true };
}

function typeIntoSelector(selector: string, text: string, clearFirst: boolean): { typed: true } | { error: string; typed: false } {
  const element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  const isElementVisible = (target: HTMLElement): boolean => {
    if (target.closest("[hidden], [aria-hidden=\"true\"], [inert]")) {
      return false;
    }

    const style = window.getComputedStyle(target);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }

    const rect = target.getBoundingClientRect();
    return target.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
  };

  if (!element) {
    return {
      error: `Element not found: ${selector}`,
      typed: false
    };
  }
  if (!isElementVisible(element)) {
    return {
      error: `Element is not visible: ${selector}`,
      typed: false
    };
  }
  if (element.matches(":disabled") || element.readOnly || element.getAttribute("aria-disabled") === "true") {
    return {
      error: `Element is not editable: ${selector}`,
      typed: false
    };
  }

  element.focus();
  const nextValue = clearFirst ? text : `${element.value}${text}`;
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, nextValue);
  } else {
    element.value = nextValue;
  }
  element.dispatchEvent(
    typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
      : new Event("input", { bubbles: true })
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { typed: true };
}

function pressKey(key: string): { pressed: true } {
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  document.activeElement?.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
  return { pressed: true };
}
