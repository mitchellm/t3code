import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_FOLDER_MAX_DEPTH,
  THREAD_FOLDER_MAX_SEGMENT_LENGTH,
  normalizeThreadFolder,
  threadFolderSegments,
} from "./threadFolder.ts";

describe("normalizeThreadFolder", () => {
  it("keeps a clean nested path as is", () => {
    expect(normalizeThreadFolder("Update 82/Prototypes")).toBe("Update 82/Prototypes");
  });

  it("trims segments and drops empty ones from stray separators", () => {
    expect(normalizeThreadFolder("  /Update 82 // Prototypes / ")).toBe("Update 82/Prototypes");
  });

  it("treats backslashes as separators", () => {
    expect(normalizeThreadFolder("Update 82\\Prototypes")).toBe("Update 82/Prototypes");
  });

  it("returns null for nothing left, so the thread is unfiled", () => {
    expect(normalizeThreadFolder(null)).toBeNull();
    expect(normalizeThreadFolder(undefined)).toBeNull();
    expect(normalizeThreadFolder("  / \\ ")).toBeNull();
  });

  it("caps depth and segment length", () => {
    const deep = Array.from({ length: THREAD_FOLDER_MAX_DEPTH + 2 }, (_, i) => `d${i}`).join("/");
    expect(threadFolderSegments(deep)).toHaveLength(THREAD_FOLDER_MAX_DEPTH);
    const long = "x".repeat(THREAD_FOLDER_MAX_SEGMENT_LENGTH + 10);
    expect(threadFolderSegments(long)[0]).toHaveLength(THREAD_FOLDER_MAX_SEGMENT_LENGTH);
  });
});
