import { describe, expect, it } from "vite-plus/test";

import {
  buildFolderMenuItem,
  buildThreadActionMenuItems,
  folderMenuId,
  parseFolderMenuAction,
  type ThreadActionMenuState,
  withoutThreadActionMenuItem,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  splitView: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
    folders: false,
  },
  folder: { current: null, existing: [] },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it("offers the split view item that matches the thread's place in the split", () => {
    expect(ids(baseState)).not.toContain("open-split");
    expect(ids(baseState)).not.toContain("close-split");
    expect(ids({ ...baseState, splitView: "open" })[0]).toBe("open-split");
    expect(ids({ ...baseState, splitView: "close" })[0]).toBe("close-split");
  });

  it("keeps the split view item available to read-only clients", () => {
    const item = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      splitView: "open",
    }).find((candidate) => candidate.id === "open-split");
    expect(item?.disabled).not.toBe(true);
  });

  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  describe("Move to folder", () => {
    const withFolders: ThreadActionMenuState = {
      ...baseState,
      supports: { ...baseState.supports, folders: true },
      folder: { current: "Update 82", existing: ["Update 82", "Update 82/Prototypes"] },
    };
    const folderItem = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).find((item) => item.id === "folder");

    it("is hidden on a server that cannot store folders", () => {
      expect(ids(baseState)).not.toContain("folder");
    });

    it("lists no folder, the project's folders and new folder, checking the current one", () => {
      const children = folderItem(withFolders)?.children ?? [];
      expect(children.map((child) => [child.id, child.label, child.checked ?? false])).toEqual([
        ["folder:none", "No folder", false],
        ["folder:path:Update 82", "Update 82", true],
        ["folder:path:Update 82/Prototypes", "Update 82/Prototypes", false],
        ["folder:new", "New folder…", false],
      ]);
    });

    it("checks no folder for an unfiled thread", () => {
      const children =
        folderItem({ ...withFolders, folder: { ...withFolders.folder, current: null } })
          ?.children ?? [];
      expect(children.find((child) => child.id === "folder:none")?.checked).toBe(true);
    });

    it("is disabled, children included, without permission", () => {
      const item = folderItem({ ...withFolders, canOperate: false });
      expect(item?.disabled).toBe(true);
      expect(item?.children?.every((child) => child.disabled)).toBe(true);
    });

    it("builds the bulk item: counted, nothing checked for a mixed selection, disabled without permission", () => {
      const item = buildFolderMenuItem({
        current: "Update 82",
        existing: ["Update 82"],
        mixed: true,
        count: 3,
        disabled: true,
      });
      expect(item.label).toBe("Move to folder (3)");
      expect(item.disabled).toBe(true);
      expect(item.children?.every((child) => child.disabled === true)).toBe(true);
      expect(item.children?.some((child) => child.checked === true)).toBe(false);
    });

    it("round-trips a folder path through its menu id", () => {
      expect(parseFolderMenuAction(folderMenuId("Update 82/Prototypes"))).toEqual({
        kind: "path",
        path: "Update 82/Prototypes",
      });
      expect(parseFolderMenuAction("folder:none")).toEqual({ kind: "none" });
      expect(parseFolderMenuAction("folder:new")).toEqual({ kind: "new" });
      expect(parseFolderMenuAction("pin")).toBeNull();
    });
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});

describe("withoutThreadActionMenuItem", () => {
  it("drops rename and keeps its separator on the next item", () => {
    const items = buildThreadActionMenuItems(baseState);
    const renameIndex = items.findIndex((item) => item.id === "rename");
    const next = withoutThreadActionMenuItem(items, "rename");
    expect(next.some((item) => item.id === "rename")).toBe(false);
    expect(next).toHaveLength(items.length - 1);
    expect(next[renameIndex]).toEqual({ ...items[renameIndex + 1], separatorBefore: true });
  });
  it("returns the menu unchanged when the item is absent", () => {
    const items = buildThreadActionMenuItems(baseState);
    expect(withoutThreadActionMenuItem(items, "open-split")).toBe(items);
  });
});
