/**
 * Fork: drag threads onto folders in the grouped active list. The rows carry no dnd-kit listeners
 * there (the list has no manual order to write), so this is a pointer gesture of its own, the
 * way the action sweep is. Where the pointer is decides the folder, like a file manager: a folder
 * header files into it, a row files where that row is, the project header unfiles.
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import {
  endThreadContextDrag,
  moveThreadContextDrag as moveThreadContextDragGhost,
} from "../chat/threadContextDrag";
import { SidebarPointerSensor } from "../Sidebar.pointer";
import { parseSidebarFolderKey, planFolderMove } from "./sidebarFolders";

const DRAG_DISTANCE = 6;
const EDGE_SCROLL_ZONE = 40;
const EDGE_SCROLL_STEP = 14;
/** Controls inside a row keep their own press; only the row body starts a drag. */
const OWN_PRESS = "button, a, input, textarea, [contenteditable='true']";

export interface FolderDropTarget {
  readonly groupKey: string;
  /** Null unfiles. */
  readonly folder: string | null;
}

export interface SidebarFolderDragInfo {
  readonly groupKey: string;
  readonly folder: string | null | undefined;
  readonly title: string;
}

export function useSidebarFolderDrag(input: {
  readonly listRef: RefObject<HTMLElement | null>;
  /** Undefined for a thread that is not in a grouped project list, which cannot be dragged. */
  readonly infoOf: (threadKey: string) => SidebarFolderDragInfo | undefined;
  readonly selectedKeys: () => ReadonlySet<string>;
  readonly onDropToFolder: (keys: readonly string[], target: FolderDropTarget) => void;
  /** A drop past the list's edge, onto something like the composer. */
  readonly onDropOutside: (point: { x: number; y: number }, keys: readonly string[]) => void;
}) {
  /** The folder the drop would file into; null when there is nothing to change there. */
  const [target, setTarget] = useState<FolderDropTarget | null>(null);
  const [draggingKeys, setDraggingKeys] = useState<ReadonlySet<string> | null>(null);
  const sensorRef = useRef<SidebarPointerSensor | null>(null);
  const edgeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pointerYRef = useRef(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ends a drag in progress, and its document listeners, when the sidebar unmounts
  useEffect(() => () => sensorRef.current?.cancel(), []);

  const resolveTarget = (point: { x: number; y: number }): FolderDropTarget | null => {
    const element = document.elementFromPoint(point.x, point.y);
    const folderKey =
      element?.closest<HTMLElement>("[data-folder-drop-key]")?.dataset.folderDropKey;
    if (folderKey !== undefined) {
      const parsed = parseSidebarFolderKey(folderKey);
      return parsed === null ? null : { groupKey: parsed.groupKey, folder: parsed.path };
    }
    const projectKey =
      element?.closest<HTMLElement>("[data-project-drop-key]")?.dataset.projectDropKey;
    if (projectKey !== undefined) return { groupKey: projectKey, folder: null };
    const rowKey = element?.closest<HTMLElement>("li[data-thread-item]")?.dataset.threadItem;
    const row = rowKey === undefined ? undefined : input.infoOf(rowKey);
    return row === undefined ? null : { groupKey: row.groupKey, folder: row.folder ?? null };
  };

  const pointerOutsideList = (point: { x: number; y: number }) => {
    const bounds = input.listRef.current?.getBoundingClientRect();
    return bounds !== undefined && (point.x < bounds.left || point.x > bounds.right);
  };

  const stopEdgeScroll = () => {
    if (edgeTimerRef.current !== null) clearInterval(edgeTimerRef.current);
    edgeTimerRef.current = null;
  };

  // A long list scrolls while the pointer rests near its top or bottom edge.
  const startEdgeScroll = () => {
    stopEdgeScroll();
    edgeTimerRef.current = setInterval(() => {
      const viewport = input.listRef.current?.closest('[data-slot="scroll-area-viewport"]');
      if (!viewport) return;
      const bounds = viewport.getBoundingClientRect();
      const y = pointerYRef.current;
      if (y < bounds.top + EDGE_SCROLL_ZONE) viewport.scrollBy({ top: -EDGE_SCROLL_STEP });
      else if (y > bounds.bottom - EDGE_SCROLL_ZONE) viewport.scrollBy({ top: EDGE_SCROLL_STEP });
    }, 16);
  };

  const onPointerDown = useStableCallback((event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || event.pointerType === "touch") return;
    if (sensorRef.current !== null) return;
    const pressed = event.target instanceof Element ? event.target : null;
    const row = pressed?.closest<HTMLElement>("li[data-thread-item]");
    const threadKey = row?.dataset.threadItem;
    if (row === null || row === undefined || threadKey === undefined) return;
    if (input.infoOf(threadKey) === undefined) return;
    const own = pressed?.closest(OWN_PRESS);
    if (own && row.contains(own)) return;

    const selected = input.selectedKeys();
    const keys = selected.has(threadKey) ? [...selected] : [threadKey];
    const labelOf = () => ({
      title: input.infoOf(threadKey)?.title.trim() || "Thread",
      count: keys.length,
    });
    const targetFor = (point: { x: number; y: number }) => {
      const next = resolveTarget(point);
      if (next === null) return null;
      const moves = planFolderMove({
        draggedKeys: keys,
        infoOf: input.infoOf,
        target: next,
      });
      return moves.length === 0 ? null : next;
    };
    const follow = (point: { x: number; y: number }) => {
      pointerYRef.current = point.y;
      moveThreadContextDragGhost(point, labelOf());
      setTarget(pointerOutsideList(point) ? null : targetFor(point));
    };

    sensorRef.current = new SidebarPointerSensor({
      active: threadKey,
      event: event.nativeEvent,
      options: {
        distance: DRAG_DISTANCE,
        onAttach: (sensor) => {
          sensorRef.current = sensor;
        },
        onFinish: () => {
          sensorRef.current = null;
          stopEdgeScroll();
          endThreadContextDrag();
          setTarget(null);
          setDraggingKeys(null);
        },
        onMove: (point) => {
          follow(point);
          return true;
        },
        onDrop: (point) => {
          if (pointerOutsideList(point)) {
            input.onDropOutside(point, keys);
            return true;
          }
          const drop = targetFor(point);
          if (drop === null) return true;
          input.onDropToFolder(
            planFolderMove({ draggedKeys: keys, infoOf: input.infoOf, target: drop }),
            drop,
          );
          return true;
        },
      },
      onPending: () => {},
      onStart: (point) => {
        setDraggingKeys(new Set(keys));
        startEdgeScroll();
        follow(point);
      },
      onMove: () => {},
      onEnd: () => {},
      onCancel: () => {},
      onAbort: () => {},
    });
  });

  return { onPointerDown, target, draggingKeys };
}
