const launchDraftKey = "openAgentBrowser.launchDraft";
const maxLaunchDraftAgeMs = 10 * 60 * 1000;

export interface LaunchDraft {
  createdAt: string;
  message: string;
}

export async function saveLaunchDraft(message: string): Promise<LaunchDraft> {
  const draft: LaunchDraft = {
    createdAt: new Date().toISOString(),
    message
  };

  await chrome.storage.local.set({
    [launchDraftKey]: draft
  });
  return draft;
}

export async function consumeLaunchDraft(): Promise<LaunchDraft | undefined> {
  const stored = await chrome.storage.local.get(launchDraftKey);
  const draft = parseLaunchDraft(stored[launchDraftKey]);
  await chrome.storage.local.remove(launchDraftKey);

  if (!draft) {
    return undefined;
  }

  const ageMs = Date.now() - Date.parse(draft.createdAt);
  return Number.isFinite(ageMs) && ageMs <= maxLaunchDraftAgeMs ? draft : undefined;
}

function parseLaunchDraft(value: unknown): LaunchDraft | undefined {
  if (!isRecord(value) || typeof value.message !== "string" || typeof value.createdAt !== "string") {
    return undefined;
  }

  const message = value.message.trim();
  return message.length > 0
    ? {
        createdAt: value.createdAt,
        message
      }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
