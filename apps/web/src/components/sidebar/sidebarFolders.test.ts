import { describe, expect, it } from "vite-plus/test";

import {
  folderIndent,
  layoutSidebarGroupFolders,
  listFolderPaths,
  parseSidebarFolderKey,
  planFolderMove,
  sidebarFolderKey,
} from "./sidebarFolders";

describe("parseSidebarFolderKey", () => {
  it("reads back the group and path of a folder key", () => {
    expect(parseSidebarFolderKey(sidebarFolderKey("env:proj", "Update 82/Prototypes"))).toEqual({
      groupKey: "env:proj",
      path: "Update 82/Prototypes",
    });
    expect(parseSidebarFolderKey("no separator")).toBeNull();
  });
});

describe("planFolderMove", () => {
  const info: Record<string, { groupKey: string; folder: string | null }> = {
    a: { groupKey: "p", folder: null },
    b: { groupKey: "p", folder: "Update 82" },
    c: { groupKey: "p", folder: "Update 82/" },
    d: { groupKey: "other", folder: null },
  };
  const plan = (draggedKeys: string[], folder: string | null, groupKey = "p") =>
    planFolderMove({ draggedKeys, infoOf: (key) => info[key], target: { groupKey, folder } });

  it("moves every selected thread of the target's project", () => {
    expect(plan(["a", "b"], "Update 83")).toEqual(["a", "b"]);
  });

  it("skips threads already in the target folder, whatever the path's spelling", () => {
    expect(plan(["a", "b", "c"], "Update 82")).toEqual(["a"]);
  });

  it("unfiles with a null target and skips threads that are already unfiled", () => {
    expect(plan(["a", "b"], null)).toEqual(["b"]);
  });

  it("leaves threads of another project and unknown keys alone", () => {
    expect(plan(["a", "d", "gone"], "Update 82")).toEqual(["a"]);
  });
});

describe("listFolderPaths", () => {
  it("lists each folder once with its parents, in reading order, skipping unfiled", () => {
    expect(
      listFolderPaths(["Update 10", null, "Update 9/Prototypes", "Update 9", undefined, ""]),
    ).toEqual(["Update 9", "Update 9/Prototypes", "Update 10"]);
  });
});

describe("folderIndent", () => {
  it("steps the Indent setting one level per folder and caps at large", () => {
    expect(folderIndent("none", 0)).toBe("none");
    expect(folderIndent("none", 1)).toBe("small");
    expect(folderIndent("small", 1)).toBe("medium");
    expect(folderIndent("medium", 3)).toBe("large");
  });
});

interface TestThread {
  readonly id: string;
  readonly folder: string | null;
}

const thread = (id: string, folder: string | null = null): TestThread => ({ id, folder });
const folderOf = (t: TestThread) => t.folder;
const none = new Set<string>();

function describeRows(layout: ReturnType<typeof layoutSidebarGroupFolders<TestThread>>) {
  return layout.rows.map((row) =>
    row.kind === "thread"
      ? `${"  ".repeat(row.depth)}${row.thread.id}`
      : `${"  ".repeat(row.depth)}[${row.name}${row.collapsed ? " +" : ""}] ${row.count}`,
  );
}

describe("layoutSidebarGroupFolders", () => {
  it("keeps unfiled threads in the incoming order when nothing is filed", () => {
    const layout = layoutSidebarGroupFolders([thread("a"), thread("b"), thread("c")], {
      groupKey: "p",
      folderOf,
      collapsedFolderKeys: none,
    });
    expect(describeRows(layout)).toEqual(["a", "b", "c"]);
    expect(layout.ordered.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("puts unfiled threads first, then folders A to Z with numbers compared as numbers", () => {
    const layout = layoutSidebarGroupFolders(
      [
        thread("filed-10", "Update 10"),
        thread("unfiled"),
        thread("filed-9", "Update 9"),
        thread("filed-proto", "Prototypes"),
      ],
      { groupKey: "p", folderOf, collapsedFolderKeys: none },
    );
    expect(describeRows(layout)).toEqual([
      "unfiled",
      "[Prototypes] 1",
      "  filed-proto",
      "[Update 9] 1",
      "  filed-9",
      "[Update 10] 1",
      "  filed-10",
    ]);
  });

  it("nests subfolders after the folder's own threads and counts the whole subtree", () => {
    const layout = layoutSidebarGroupFolders(
      [
        thread("deep", "Update 82/Prototypes"),
        thread("top", "Update 82"),
        thread("deep-2", "Update 82/Prototypes"),
      ],
      { groupKey: "p", folderOf, collapsedFolderKeys: none },
    );
    expect(describeRows(layout)).toEqual([
      "[Update 82] 3",
      "  top",
      "  [Prototypes] 2",
      "    deep",
      "    deep-2",
    ]);
  });

  it("creates the parent folder for a thread filed only in a subfolder", () => {
    const layout = layoutSidebarGroupFolders([thread("only", "A/B")], {
      groupKey: "p",
      folderOf,
      collapsedFolderKeys: none,
    });
    expect(describeRows(layout)).toEqual(["[A] 1", "  [B] 1", "    only"]);
  });

  it("hides a collapsed folder's rows but still orders and counts its threads", () => {
    const layout = layoutSidebarGroupFolders(
      [thread("a", "Update 82"), thread("b", "Update 82/Prototypes"), thread("c")],
      {
        groupKey: "p",
        folderOf,
        collapsedFolderKeys: new Set([sidebarFolderKey("p", "Update 82")]),
      },
    );
    expect(describeRows(layout)).toEqual(["c", "[Update 82 +] 2"]);
    expect(layout.ordered.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("collapses only the subfolder when the parent stays open", () => {
    const layout = layoutSidebarGroupFolders(
      [thread("a", "Update 82"), thread("b", "Update 82/Prototypes")],
      {
        groupKey: "p",
        folderOf,
        collapsedFolderKeys: new Set([sidebarFolderKey("p", "Update 82/Prototypes")]),
      },
    );
    expect(describeRows(layout)).toEqual(["[Update 82] 2", "  a", "  [Prototypes +] 1"]);
  });

  it("treats a path that normalizes to nothing as unfiled", () => {
    const layout = layoutSidebarGroupFolders([thread("a", " / "), thread("b", "")], {
      groupKey: "p",
      folderOf,
      collapsedFolderKeys: none,
    });
    expect(describeRows(layout)).toEqual(["a", "b"]);
  });

  it("scopes collapse state to the project group", () => {
    const layout = layoutSidebarGroupFolders([thread("a", "Update 82")], {
      groupKey: "p",
      folderOf,
      collapsedFolderKeys: new Set([sidebarFolderKey("other-project", "Update 82")]),
    });
    expect(describeRows(layout)).toEqual(["[Update 82] 1", "  a"]);
  });
});
