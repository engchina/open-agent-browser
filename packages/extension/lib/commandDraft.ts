export const commandIds = {
  openPanel: "open-agent-browser.open-panel",
  summarizePage: "open-agent-browser.summarize-page"
} as const;

export type CommandId = typeof commandIds[keyof typeof commandIds];

export interface CommandDraftInput {
  command: string;
  pageUrl?: string;
}

export function createCommandDraftMessage(input: CommandDraftInput): string | undefined {
  if (input.command !== commandIds.summarizePage) {
    return undefined;
  }

  const pageUrl = input.pageUrl?.trim();
  return pageUrl
    ? `Summarize this page and extract the key links: ${pageUrl}`
    : "Summarize this page and extract the key links.";
}
