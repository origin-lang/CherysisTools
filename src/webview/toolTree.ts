import * as vscode from "vscode";
import { toolRegistry, ToolCategory, ToolMeta } from "../core/toolRegistry.js";

export interface GroupNode {
  key: ToolCategory;
}

export interface ToolNode {
  meta: ToolMeta;
}

const GROUP_INFO: Record<ToolCategory, { label: string; icon: string }> = {
  system: { label: "系统管理", icon: "database" },
  utility: { label: "小工具", icon: "tools" },
};

export class ToolTreeProvider implements vscode.TreeDataProvider<GroupNode | ToolNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<GroupNode | ToolNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: GroupNode | ToolNode): vscode.TreeItem {
    if ("meta" in element) {
      const item = new vscode.TreeItem(element.meta.title);
      item.iconPath = new vscode.ThemeIcon(GROUP_INFO[element.meta.category].icon);
      item.command = {
        command: "Cherysis.openTool",
        title: "打开工具",
        arguments: [element.meta.toolName],
      };
      return item;
    }
    const item = new vscode.TreeItem(GROUP_INFO[element.key].label);
    item.iconPath = new vscode.ThemeIcon("folder");
    item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    return item;
  }

  getChildren(element?: GroupNode | ToolNode): Array<GroupNode | ToolNode> {
    if (!element) {
      return [{ key: "system" }, { key: "utility" }];
    }
    if ("meta" in element) {
      return [];
    }
    return toolRegistry.toolList
      .filter((t) => t.category === element.key)
      .map((meta) => ({ meta }));
  }

  getParent(element: GroupNode | ToolNode): GroupNode | undefined {
    if ("meta" in element) {
      return { key: element.meta.category };
    }
    return undefined;
  }
}

export const toolTreeProvider = new ToolTreeProvider();