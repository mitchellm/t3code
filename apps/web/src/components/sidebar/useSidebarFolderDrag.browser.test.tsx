import { page } from "vite-plus/test/browser";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { sidebarFolderKey } from "./sidebarFolders";
import { useSidebarFolderDrag, type SidebarFolderDragInfo } from "./useSidebarFolderDrag";

const INFO: Record<string, SidebarFolderDragInfo> = {
  loose: { groupKey: "g", folder: null, title: "Loose" },
  filed: { groupKey: "g", folder: "Update 82", title: "Filed" },
  second: { groupKey: "g", folder: null, title: "Second" },
  elsewhere: { groupKey: "other", folder: null, title: "Elsewhere" },
};

function Harness(props: {
  selected: ReadonlySet<string>;
  onDropToFolder: (
    keys: readonly string[],
    target: { groupKey: string; folder: string | null },
  ) => void;
  onDropOutside: (point: { x: number; y: number }, keys: readonly string[]) => void;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const drag = useSidebarFolderDrag({
    listRef,
    infoOf: (key) => INFO[key],
    selectedKeys: () => props.selected,
    onDropToFolder: props.onDropToFolder,
    onDropOutside: props.onDropOutside,
  });
  return (
    <ul
      ref={listRef}
      onPointerDown={drag.onPointerDown}
      style={{ width: 200, listStyle: "none", margin: 0, padding: 0 }}
    >
      <li data-project-drop-key="g" data-active={drag.target?.folder === null || undefined}>
        <div style={{ height: 30 }}>Project</div>
      </li>
      <li data-thread-item="loose">
        <div style={{ height: 30 }}>Loose</div>
      </li>
      <li data-thread-item="second">
        <div style={{ height: 30 }}>Second</div>
      </li>
      <li
        data-folder-drop-key={sidebarFolderKey("g", "Update 83")}
        data-active={drag.target?.folder === "Update 83" || undefined}
      >
        <div style={{ height: 30 }}>Update 83</div>
      </li>
      <li data-thread-item="filed">
        <div style={{ height: 30 }}>Filed</div>
        <button type="button" style={{ height: 20 }}>
          Settle
        </button>
      </li>
      <li data-thread-item="elsewhere">
        <div style={{ height: 30 }}>Elsewhere</div>
      </li>
    </ul>
  );
}

const centerOf = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

function press(target: Element) {
  const { x, y } = centerOf(target);
  target.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    }),
  );
}

function pointerAt(type: "pointermove" | "pointerup", point: { x: number; y: number }) {
  document.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: point.x,
      clientY: point.y,
    }),
  );
}

describe("useSidebarFolderDrag", () => {
  const setup = async (selected: ReadonlySet<string> = new Set()) => {
    await page.viewport(800, 600);
    const onDropToFolder = vi.fn();
    const onDropOutside = vi.fn();
    const screen = await render(
      <Harness selected={selected} onDropToFolder={onDropToFolder} onDropOutside={onDropOutside} />,
      { router: false /* no routes involved */ },
    );
    const row = (key: string) => screen.container.querySelector(`[data-thread-item="${key}"]`)!;
    const folder = screen.container.querySelector("[data-folder-drop-key]")!;
    const project = screen.container.querySelector("[data-project-drop-key]")!;
    return { screen, onDropToFolder, onDropOutside, row, folder, project };
  };

  it("files the dragged thread into the folder it is released on", async () => {
    const { screen, onDropToFolder, row, folder } = await setup();
    await using _screen = screen;
    await act(async () => {
      press(row("loose"));
      pointerAt("pointermove", centerOf(folder));
    });
    expect(folder.getAttribute("data-active")).toBe("true");
    await act(async () => pointerAt("pointerup", centerOf(folder)));
    expect(onDropToFolder).toHaveBeenCalledExactlyOnceWith(["loose"], {
      groupKey: "g",
      folder: "Update 83",
    });
    expect(folder.getAttribute("data-active")).toBeNull();
  });

  it("moves the whole selection when the dragged row is part of it", async () => {
    const { screen, onDropToFolder, row, folder } = await setup(new Set(["loose", "second"]));
    await using _screen = screen;
    await act(async () => {
      press(row("second"));
      pointerAt("pointermove", centerOf(folder));
      pointerAt("pointerup", centerOf(folder));
    });
    expect(onDropToFolder).toHaveBeenCalledExactlyOnceWith(["loose", "second"], {
      groupKey: "g",
      folder: "Update 83",
    });
  });

  it("drags only the pressed thread when it is outside the selection", async () => {
    const { screen, onDropToFolder, row, folder } = await setup(new Set(["second"]));
    await using _screen = screen;
    await act(async () => {
      press(row("loose"));
      pointerAt("pointermove", centerOf(folder));
      pointerAt("pointerup", centerOf(folder));
    });
    expect(onDropToFolder).toHaveBeenCalledExactlyOnceWith(["loose"], expect.anything());
  });

  it("files where a row sits and unfiles on the project header", async () => {
    const { screen, onDropToFolder, row, project } = await setup();
    await using _screen = screen;
    await act(async () => {
      press(row("loose"));
      pointerAt("pointermove", centerOf(row("filed")));
      pointerAt("pointerup", centerOf(row("filed")));
    });
    expect(onDropToFolder).toHaveBeenLastCalledWith(["loose"], {
      groupKey: "g",
      folder: "Update 82",
    });
    await act(async () => {
      press(row("filed"));
      pointerAt("pointermove", centerOf(project));
      pointerAt("pointerup", centerOf(project));
    });
    expect(onDropToFolder).toHaveBeenLastCalledWith(["filed"], { groupKey: "g", folder: null });
  });

  it("does nothing for a drop that would not change anything or crosses projects", async () => {
    const { screen, onDropToFolder, row } = await setup();
    await using _screen = screen;
    await act(async () => {
      press(row("loose"));
      pointerAt("pointermove", centerOf(row("second")));
      pointerAt("pointerup", centerOf(row("second")));
    });
    await act(async () => {
      press(row("loose"));
      pointerAt("pointermove", centerOf(row("elsewhere")));
      pointerAt("pointerup", centerOf(row("elsewhere")));
    });
    expect(onDropToFolder).not.toHaveBeenCalled();
  });

  it("leaves a plain click, and presses on a row's own buttons, alone", async () => {
    const { screen, onDropToFolder, row, folder } = await setup();
    await using _screen = screen;
    await act(async () => {
      press(row("loose"));
      pointerAt("pointerup", centerOf(row("loose")));
      press(row("filed").querySelector("button")!);
      pointerAt("pointermove", centerOf(folder));
      pointerAt("pointerup", centerOf(folder));
    });
    expect(onDropToFolder).not.toHaveBeenCalled();
  });

  it("hands a drop past the list's edge to the outside handler", async () => {
    const { screen, onDropToFolder, onDropOutside, row } = await setup();
    await using _screen = screen;
    const outside = { x: 600, y: 100 };
    await act(async () => {
      press(row("loose"));
      pointerAt("pointermove", outside);
      pointerAt("pointerup", outside);
    });
    expect(onDropOutside).toHaveBeenCalledExactlyOnceWith(outside, ["loose"]);
    expect(onDropToFolder).not.toHaveBeenCalled();
  });

  it("cancels on Escape", async () => {
    const { screen, onDropToFolder, row, folder } = await setup();
    await using _screen = screen;
    await act(async () => {
      press(row("loose"));
      pointerAt("pointermove", centerOf(folder));
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }));
      pointerAt("pointerup", centerOf(folder));
    });
    expect(onDropToFolder).not.toHaveBeenCalled();
    expect(folder.getAttribute("data-active")).toBeNull();
  });
});
