import * as vscode from "vscode";

/** 工具执行时的日志回调 */
export type LogCallback = (msg: string) => void;

/** 以这些符号开头的日志视为操作结果，会额外弹 Toast */
const RESULT_MARKERS = new Set([
  "✅", "❌", "✏️", "🗑", "🔻", "🔺", "📐", "📦", "📝", "📥", "🖊", "⭐", "☆",
  "🖼", "🔒", "🔓", "⚙", "📁", "⚠", "ℹ", "⏭", "↩", "↪", "➕",
]);

/** 注入给每个工具的通用上下文，封装 webview 交互与通用对话框 */
export interface ToolContext {
  panel: vscode.WebviewPanel;
  extensionUri: vscode.Uri;
  /** 扩展全局存储目录，用于存放跨工作区共享的数据(如SQLite) */
  storageDir: string;
  /** VS Code 全局存储目录（C盘默认位置），storageDir 未配置时两者相同，用于双目录异地备份 */
  defaultStorageDir: string;
  postToWebview(msg: any): void;
  log(text: string): void;
  selectFolder(title?: string): Promise<string | undefined>;
  selectFile(filters?: Record<string, string[]>): Promise<string | undefined>;
  selectFiles(filters?: Record<string, string[]>): Promise<string[]>;
  /** 弹出模态确认对话框，返回用户是否确认 */
  confirm(message: string, detail?: string): Promise<boolean>;
  chooseAction(message: string, detail: string, actions: string[]): Promise<string | undefined>;
}

/** 创建工具上下文 */
export function createToolContext(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
  storageDir: string,
  defaultStorageDir: string,
): ToolContext {
  return {
    panel,
    extensionUri,
    storageDir,
    defaultStorageDir,
    postToWebview(msg: any) {
      panel.webview.postMessage(msg);
    },
    log(text: string) {
      panel.webview.postMessage({ type: "log", text });
      const head = Array.from(text)[0];
      if (head && RESULT_MARKERS.has(head)) {
        panel.webview.postMessage({ type: "toast", text: text.split("\n")[0] });
      }
    },
    async selectFolder(title) {
      const res = await vscode.window.showOpenDialog({
        title,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      return res && res.length > 0 ? res[0].fsPath : undefined;
    },
    async selectFile(filters) {
      const res = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters,
      });
      return res && res.length > 0 ? res[0].fsPath : undefined;
    },
    async selectFiles(filters) {
      const res = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        filters,
      });
      return res ? res.map((u) => u.fsPath) : [];
    },
    async confirm(message, detail) {
      const pick = await vscode.window.showWarningMessage(
        message,
        { modal: true, detail },
        "确定",
      );
      return pick === "确定";
    },
    async chooseAction(message, detail, actions) {
      const items: vscode.MessageItem[] = actions.map((title, index) => ({
        title,
        isCloseAffordance: index === actions.length - 1,
      }));
      const picked = await vscode.window.showWarningMessage<vscode.MessageItem>(
        message,
        { modal: true, detail },
        ...items,
      );
      return picked?.title;
    },
  };
}

const IMAGE_FILTER: Record<string, string[]> = {
  图片: ["jpg", "jpeg", "png", "bmp", "webp"],
};

/** 常用的图片文件过滤器 */
export const imageFileFilter = IMAGE_FILTER;
