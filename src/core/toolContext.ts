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
  /**
   * 本机偏好存取（ExtensionContext.globalState → %APPDATA%\Code\User\globalStorage\state.vscdb，C 盘）。
   * 同一份 shop.db 被多人共享时，各人机器上的路径写法 / 字号 / 字段显隐各不相同，
   * 存进库里就是「全组一份、最后改的人覆盖所有人」。这些键一律走这里，永不写共享盘。
   */
  prefs: vscode.Memento;
  postToWebview(msg: any): void;
  log(text: string): void;
  selectFolder(title?: string): Promise<string | undefined>;
  selectFile(filters?: Record<string, string[]>): Promise<string | undefined>;
  selectFiles(filters?: Record<string, string[]>): Promise<string[]>;
  /** 弹出模态确认对话框，返回用户是否确认 */
  confirm(message: string, detail?: string): Promise<boolean>;
  /** 弹多个自定义按钮的模态对话框，返回被点的那个；关窗或点最后一项兜底项为 undefined */
  chooseAction(message: string, detail: string, actions: string[]): Promise<string | undefined>;
  /**
   * 把本机文件路径转成前端能直接加载的图片地址。
   * VS Code：webview 资源 URI（原图不进 base64，浏览器自己流式解码）；
   * 网页版：`/image` 端点。handler 一律走这里，别再直接碰 panel.webview。
   */
  imageUrl(fp: string): string;
  /**
   * 在系统文件管理器里定位文件。
   * VS Code：revealFileInOS；网页版做不到 → 改成"给下载 / 给共享路径"。
   */
  revealInOS(fp: string): Promise<void>;
  /**
   * 让用户重新选数据存储目录。
   * VS Code：走 `Cherysis.setStorageDir` 命令（选目录/确认/关连接都在那儿）；
   * 网页版：目录是服务端配置，网页上只读展示、不提供这个动作。
   */
  pickStorageDir(): Promise<void>;
}

/** 创建工具上下文 */
export function createToolContext(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
  storageDir: string,
  defaultStorageDir: string,
  prefs: vscode.Memento,
): ToolContext {
  return {
    panel,
    extensionUri,
    storageDir,
    defaultStorageDir,
    prefs,
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
    imageUrl(fp) {
      // 走资源 URI 而不是 base64：原图几 MB，base64 过一次 postMessage 就是几十 MB 流量，
      // 且每次点开放大都要重来；URI 由浏览器自己流式解码、0 拷贝、100% 原图。
      // 前提是该文件在面板的 localResourceRoots 白名单里（面板创建时按当时的图片根目录收集）。
      return panel.webview.asWebviewUri(vscode.Uri.file(fp)).toString();
    },
    async revealInOS(fp) {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fp));
    },
    async pickStorageDir() {
      await vscode.commands.executeCommand("Cherysis.setStorageDir");
    },
  };
}

const IMAGE_FILTER: Record<string, string[]> = {
  图片: ["jpg", "jpeg", "png", "bmp", "webp"],
};

/** 常用的图片文件过滤器 */
export const imageFileFilter = IMAGE_FILTER;
