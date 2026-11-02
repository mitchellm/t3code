import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THREAD_FOLDER_SEPARATOR = "/";
export const THREAD_FOLDER_MAX_DEPTH = 4;
export const THREAD_FOLDER_MAX_SEGMENT_LENGTH = 48;

/**
 * A folder is only a path on the thread, like `Update 82/Prototypes`. There is no folder record:
 * a folder exists while a thread is in it, so there is nothing to sync, rename-race or orphan.
 */
export const ThreadFolder = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ThreadFolder = typeof ThreadFolder.Type;

/** Path segments in order, with blanks dropped and depth and segment length capped. */
export function threadFolderSegments(input: string | null | undefined): readonly string[] {
  if (input == null) return [];
  return input
    .split(/[\\/]/)
    .map((segment) => segment.trim().slice(0, THREAD_FOLDER_MAX_SEGMENT_LENGTH).trim())
    .filter((segment) => segment.length > 0)
    .slice(0, THREAD_FOLDER_MAX_DEPTH);
}

/** The canonical path, or null when nothing is left (an unfiled thread). */
export function normalizeThreadFolder(input: string | null | undefined): string | null {
  const segments = threadFolderSegments(input);
  return segments.length === 0 ? null : segments.join(THREAD_FOLDER_SEPARATOR);
}
