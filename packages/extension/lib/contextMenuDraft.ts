export const contextMenuIds = {
  link: "open-agent-browser.ask-link",
  page: "open-agent-browser.ask-page",
  selection: "open-agent-browser.ask-selection"
} as const;

export interface ContextMenuDraftInput {
  linkUrl?: string;
  menuItemId: string | number;
  pageUrl?: string;
  selectionText?: string;
}

const maxSelectionLength = 2000;

export function createContextMenuDraftMessage(input: ContextMenuDraftInput): string | undefined {
  const menuItemId = String(input.menuItemId);

  if (menuItemId === contextMenuIds.selection) {
    const selection = normalizeText(input.selectionText);
    if (!selection) {
      return undefined;
    }

    const source = input.pageUrl ? ` on ${input.pageUrl}` : "";
    return `Summarize this selected text${source}:\n\n${truncateText(selection, maxSelectionLength)}`;
  }

  if (menuItemId === contextMenuIds.link) {
    const linkUrl = normalizeText(input.linkUrl);
    if (!linkUrl) {
      return undefined;
    }

    const source = input.pageUrl ? ` from ${input.pageUrl}` : "";
    return `Open this link${source}, summarize it, and extract the key links: ${linkUrl}`;
  }

  if (menuItemId === contextMenuIds.page) {
    const pageUrl = normalizeText(input.pageUrl);
    return pageUrl
      ? `Summarize this page and extract the key links: ${pageUrl}`
      : "Summarize this page and extract the key links.";
  }

  return undefined;
}

function normalizeText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}...`;
}
