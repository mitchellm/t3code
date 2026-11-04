import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarFolderHeader } from "./SidebarFolderHeader";

const header = (overrides: Partial<Parameters<typeof SidebarFolderHeader>[0]> = {}) => (
  <ul>
    <SidebarFolderHeader
      name="Prototypes"
      path="Update 82/Prototypes"
      count={3}
      collapsed={false}
      indent="small"
      dropKey="group\u001fUpdate 82/Prototypes"
      dropActive={false}
      onToggle={() => undefined}
      {...overrides}
    />
  </ul>
);

describe("SidebarFolderHeader", () => {
  it("starts a thread in the folder from the button without folding it", async () => {
    await page.viewport(800, 600);
    const onNewThread = vi.fn();
    const onToggle = vi.fn();
    await using screen = await render(header({ onNewThread, onToggle }), {
      router: false /* no routes involved */,
    });

    await page.getByRole("button", { name: "New thread in Update 82/Prototypes" }).click();

    expect(onNewThread).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.container.querySelector("[data-folder-drop-key]")).not.toBeNull();
  });

  it("folds from the folder's own button and has no new-thread button when there is no project", async () => {
    await page.viewport(800, 600);
    const onToggle = vi.fn();
    await using _screen = await render(header({ onToggle }), {
      router: false /* no routes involved */,
    });

    await page.getByRole("button", { name: /Prototypes/ }).click();

    expect(onToggle).toHaveBeenCalledOnce();
    expect(page.getByRole("button", { name: /New thread in/ }).elements()).toHaveLength(0);
  });
});
