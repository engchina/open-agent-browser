export interface OmniboxDraftInput {
  pageUrl?: string;
  text: string;
}

const maxOmniboxTextLength = 1000;

export function createOmniboxDraftMessage(input: OmniboxDraftInput): string {
  const text = truncateText(normalizeText(input.text), maxOmniboxTextLength);
  const pageUrl = normalizeText(input.pageUrl);

  if (!text) {
    return pageUrl
      ? `Summarize this page and extract the key links: ${pageUrl}`
      : "Summarize this page and extract the key links.";
  }

  if (isHttpUrl(text)) {
    return `Open this URL, summarize it, and extract the key links: ${text}`;
  }

  const source = pageUrl ? ` for the current page ${pageUrl}` : "";
  return `Answer this browser task${source}: ${text}`;
}

function normalizeText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
