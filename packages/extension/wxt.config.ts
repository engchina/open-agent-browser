import { defineConfig } from "wxt";
import { commandIds } from "./lib/commandDraft.js";

export default defineConfig({
  manifest: {
    action: {
      default_title: "Open Agent Browser"
    },
    commands: {
      [commandIds.openPanel]: {
        description: "Open Open Agent side panel",
        suggested_key: {
          default: "Alt+Shift+A"
        }
      },
      [commandIds.summarizePage]: {
        description: "Draft a summary task for the current page",
        suggested_key: {
          default: "Alt+Shift+S"
        }
      }
    },
    host_permissions: ["<all_urls>"],
    name: "Open Agent Browser",
    omnibox: {
      keyword: "agent"
    },
    options_page: "options.html",
    permissions: ["activeTab", "contextMenus", "downloads", "scripting", "sidePanel", "storage", "tabs"],
    side_panel: {
      default_path: "sidepanel.html"
    },
    version: "0.1.0"
  },
  modules: ["@wxt-dev/module-react"]
});
