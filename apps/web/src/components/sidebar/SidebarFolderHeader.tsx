import type { SidebarThreadIndent } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon, FolderOpenIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** Same margins the thread rows use, so a folder lines up with the threads beside it. */
function folderIndentClassName(indent: SidebarThreadIndent): string | undefined {
  switch (indent) {
    case "small":
      return "ms-3";
    case "medium":
      return "ms-5";
    case "large":
      return "ms-8";
    case "none":
      return undefined;
  }
}

/**
 * A folder inside a project's group. Click folds it; the count shows while it is folded.
 * Lighter than the project header so the project stays the strongest line in the list.
 */
export function SidebarFolderHeader(props: {
  name: string;
  path: string;
  count: number;
  collapsed: boolean;
  indent: SidebarThreadIndent;
  onToggle: () => void;
}) {
  const Icon = props.collapsed ? FolderIcon : FolderOpenIcon;
  const buttonProps = {
    type: "button",
    onClick: props.onToggle,
    "aria-expanded": !props.collapsed,
    className:
      "flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  } as const;
  const content = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
      <span className="min-w-0 truncate">{props.name}</span>
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 text-sidebar-muted-foreground opacity-0 transition-[opacity,transform] group-focus-within/folder-header:opacity-100 group-hover/folder-header:opacity-100",
          props.collapsed && "-rotate-90",
        )}
      />
      <span className="flex-1" />
      {props.collapsed ? (
        <span className="shrink-0 tabular-nums text-sidebar-muted-foreground/70">
          {props.count}
        </span>
      ) : null}
    </>
  );
  return (
    <li
      className={cn(
        "group/folder-header mx-0.5 flex list-none",
        folderIndentClassName(props.indent),
      )}
      data-testid="sidebar-folder-header"
    >
      {/* A nested folder shows only its last segment, so hovering it gives the whole path. */}
      {props.path === props.name ? (
        <button {...buttonProps}>{content}</button>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<button {...buttonProps} />}>{content}</TooltipTrigger>
          <TooltipPopup side="top">{props.path}</TooltipPopup>
        </Tooltip>
      )}
    </li>
  );
}
