import { createContext, useContext } from "react";

export const BitSafeSettingsViewContext = createContext(false);
export const useBitSafeSettingsView = () => useContext(BitSafeSettingsViewContext);

export const BITSAFE_SETTING_LOCATIONS: Readonly<
  Record<
    string,
    {
      to: "/settings/general" | "/settings/diffs" | "/settings/worktrees";
      label: string;
      hash: string;
    }
  >
> = {
  "usage-pace-weekends": { to: "/settings/general", label: "General", hash: "usage-pace-weekends" },
  "usage-bars-fill-used": {
    to: "/settings/general",
    label: "General",
    hash: "usage-bars-fill-used",
  },
  "compact-thread-rows": { to: "/settings/general", label: "General", hash: "compact-thread-rows" },
  "thread-details-card": { to: "/settings/general", label: "General", hash: "thread-details-card" },
  "automatic-pr-comment-assessment": {
    to: "/settings/diffs",
    label: "Diffs & pull requests",
    hash: "automatic-pr-comment-assessment",
  },
  "focused-pull-request-view": {
    to: "/settings/diffs",
    label: "Diffs & pull requests",
    hash: "focused-pull-request-view",
  },
  "pull-request-auto-merge": {
    to: "/settings/diffs",
    label: "Diffs & pull requests",
    hash: "pull-request-auto-merge",
  },
  "daily-summary-instructions": {
    to: "/settings/general",
    label: "General",
    hash: "daily-summary-instructions",
  },
  "factory-prompt-template": {
    to: "/settings/general",
    label: "General",
    hash: "factory-prompt-template",
  },
  "factory-token-saving": {
    to: "/settings/general",
    label: "General",
    hash: "factory-token-saving",
  },
  "factory-pull-request-opens-in-browser": {
    to: "/settings/general",
    label: "General",
    hash: "factory-pull-request-opens-in-browser",
  },
  "overlay-mode": { to: "/settings/general", label: "General", hash: "overlay-mode" },
  "overlay-idle-pill": { to: "/settings/general", label: "General", hash: "overlay-idle-pill" },
  "quick-replies": { to: "/settings/general", label: "General", hash: "quick-replies" },
  "upstream-release": { to: "/settings/general", label: "General", hash: "upstream-release" },
  "factory-ignore-ci-enabled": {
    to: "/settings/general",
    label: "General",
    hash: "factory-ignore-ci-enabled",
  },
  "storage-worktree-ignore-patterns": {
    to: "/settings/worktrees",
    label: "Worktrees",
    hash: "storage-worktrees",
  },
};
