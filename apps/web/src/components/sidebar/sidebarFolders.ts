/**
 * Fork: lays one project group's threads out under their folders. Unfiled threads come first in
 * the sidebar's sort order; folders follow A to Z, never by activity, so a folder holds its place.
 */
import {
  THREAD_FOLDER_SEPARATOR,
  threadFolderSegments,
  type SidebarThreadIndent,
} from "@t3tools/contracts";

const INDENT_STEPS: readonly SidebarThreadIndent[] = ["none", "small", "medium", "large"];

/**
 * The Indent setting moved `steps` levels deeper, capped at the largest. Each folder level the
 * row sits in is one step, so a thread in a folder reads as nested even when Indent is none.
 */
export function folderIndent(base: SidebarThreadIndent, steps: number): SidebarThreadIndent {
  const index = Math.min(INDENT_STEPS.length - 1, INDENT_STEPS.indexOf(base) + steps);
  return INDENT_STEPS[Math.max(0, index)]!;
}

export interface SidebarFolderRow {
  readonly kind: "folder";
  /** Stable across renders: the group key plus the folder path. Collapse state is keyed by it. */
  readonly key: string;
  readonly path: string;
  readonly name: string;
  /** 0 for a top-level folder. */
  readonly depth: number;
  /** Every thread in the folder and its subfolders, collapsed or not. */
  readonly count: number;
  readonly collapsed: boolean;
}

export interface SidebarFolderThreadRow<T> {
  readonly kind: "thread";
  readonly thread: T;
  /** Folder levels above the thread; 0 for an unfiled thread. */
  readonly depth: number;
}

export type SidebarGroupRow<T> = SidebarFolderRow | SidebarFolderThreadRow<T>;

export interface SidebarGroupLayout<T> {
  /** The rows to render in order. A collapsed folder contributes its header and nothing else. */
  readonly rows: readonly SidebarGroupRow<T>[];
  /** Every thread in layout order, including those hidden in collapsed folders. */
  readonly ordered: readonly T[];
}

interface FolderNode<T> {
  readonly name: string;
  readonly path: string;
  readonly threads: T[];
  readonly children: Map<string, FolderNode<T>>;
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Every folder a project has, parents included, for the "Move to folder" picker. A thread filed
 * in `A/B` makes `A` pickable too, since the sidebar draws `A` for it.
 */
export function listFolderPaths(folders: Iterable<string | null | undefined>): readonly string[] {
  const paths = new Set<string>();
  for (const folder of folders) {
    const segments = threadFolderSegments(folder);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      paths.add(segments.slice(0, depth).join(THREAD_FOLDER_SEPARATOR));
    }
  }
  return [...paths].sort((left, right) => nameCollator.compare(left, right));
}

export function sidebarFolderKey(groupKey: string, path: string): string {
  return `${groupKey}\u001f${path}`;
}

function countThreads<T>(node: FolderNode<T>): number {
  let total = node.threads.length;
  for (const child of node.children.values()) total += countThreads(child);
  return total;
}

export function layoutSidebarGroupFolders<T>(
  threads: readonly T[],
  options: {
    readonly groupKey: string;
    readonly folderOf: (thread: T) => string | null | undefined;
    readonly collapsedFolderKeys: ReadonlySet<string>;
  },
): SidebarGroupLayout<T> {
  const root: FolderNode<T> = { name: "", path: "", threads: [], children: new Map() };
  for (const thread of threads) {
    let node = root;
    const segments: string[] = [];
    for (const segment of threadFolderSegments(options.folderOf(thread))) {
      segments.push(segment);
      let child = node.children.get(segment);
      if (child === undefined) {
        child = {
          name: segment,
          path: segments.join(THREAD_FOLDER_SEPARATOR),
          threads: [],
          children: new Map(),
        };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.threads.push(thread);
  }

  const rows: SidebarGroupRow<T>[] = [];
  const ordered: T[] = [];
  const emitThreads = (node: FolderNode<T>, depth: number, visible: boolean) => {
    for (const thread of node.threads) {
      ordered.push(thread);
      if (visible) rows.push({ kind: "thread", thread, depth });
    }
  };
  const emitFolders = (parent: FolderNode<T>, depth: number, visible: boolean) => {
    const children = [...parent.children.values()].sort((left, right) =>
      nameCollator.compare(left.name, right.name),
    );
    for (const node of children) {
      const key = sidebarFolderKey(options.groupKey, node.path);
      const collapsed = options.collapsedFolderKeys.has(key);
      if (visible) {
        rows.push({
          kind: "folder",
          key,
          path: node.path,
          name: node.name,
          depth,
          count: countThreads(node),
          collapsed,
        });
      }
      const showInside = visible && !collapsed;
      emitThreads(node, depth + 1, showInside);
      emitFolders(node, depth + 1, showInside);
    }
  };
  emitThreads(root, 0, true);
  emitFolders(root, 0, true);
  return { rows, ordered };
}
