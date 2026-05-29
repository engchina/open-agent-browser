import { defineBackground } from "wxt/utils/define-background";
import { commandIds, createCommandDraftMessage } from "../lib/commandDraft.js";
import { contextMenuIds, createContextMenuDraftMessage } from "../lib/contextMenuDraft.js";
import { saveLaunchDraft } from "../lib/launchDraft.js";
import { createOmniboxDraftMessage } from "../lib/omniboxDraft.js";

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel?.setPanelBehavior?.({
      openPanelOnActionClick: true
    });
    void installContextMenus();
    installOmniboxSuggestion();
  });

  chrome.runtime.onStartup?.addListener(() => {
    void installContextMenus();
    installOmniboxSuggestion();
  });

  chrome.action.onClicked.addListener(async (tab) => {
    await openSidePanel(tab);
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void handleContextMenuClick(info, tab);
  });

  chrome.commands.onCommand.addListener((command) => {
    void handleCommand(command);
  });

  chrome.omnibox.onInputEntered.addListener((text) => {
    void handleOmniboxInput(text);
  });
});

async function installContextMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    contexts: ["page"],
    id: contextMenuIds.page,
    title: "Ask Open Agent about this page"
  });
  chrome.contextMenus.create({
    contexts: ["selection"],
    id: contextMenuIds.selection,
    title: "Ask Open Agent about selected text"
  });
  chrome.contextMenus.create({
    contexts: ["link"],
    id: contextMenuIds.link,
    title: "Ask Open Agent about this link"
  });
}

async function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const pageUrl = info.pageUrl ?? tab?.url;
  const message = createContextMenuDraftMessage({
    menuItemId: info.menuItemId,
    ...(info.linkUrl ? { linkUrl: info.linkUrl } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(info.selectionText ? { selectionText: info.selectionText } : {})
  });

  if (!message) {
    return;
  }

  await saveLaunchDraft(message);
  await openSidePanel(tab);
}

async function handleOmniboxInput(text: string): Promise<void> {
  const tab = await getActiveTab();
  await saveLaunchDraft(createOmniboxDraftMessage({
    text,
    ...(tab?.url ? { pageUrl: tab.url } : {})
  }));
  await openSidePanel(tab);
}

async function handleCommand(command: string): Promise<void> {
  if (command !== commandIds.openPanel && command !== commandIds.summarizePage) {
    return;
  }

  const tab = await getActiveTab();
  const draftMessage = createCommandDraftMessage({
    command,
    ...(tab?.url ? { pageUrl: tab.url } : {})
  });

  if (draftMessage) {
    await saveLaunchDraft(draftMessage);
  }

  await openSidePanel(tab);
}

function installOmniboxSuggestion(): void {
  chrome.omnibox.setDefaultSuggestion({
    description: "Ask Open Agent about this page, a URL, or a browser task"
  });
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tab;
}

async function openSidePanel(tab?: chrome.tabs.Tab): Promise<void> {
  if (typeof tab?.id === "number") {
    await chrome.sidePanel.open({
      tabId: tab.id
    });
    return;
  }

  await chrome.sidePanel.open({
    windowId: chrome.windows.WINDOW_ID_CURRENT
  });
}
