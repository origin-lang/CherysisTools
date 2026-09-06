import * as vscode from "vscode";
import * as fs from "fs";
import { createToolContext, ToolContext } from "./toolContext.js";

/** 每个工具必须导出的定义 */
export interface ToolDefinition {
  toolName: string;
  title: string;
  /** fragment.html 相对 src 根目录的路径，如 "tools/imageBatchTool/fragment.html" */
  fragmentPath?: string;
  /** 工具专属前端脚本 client.js 的相对路径（可选），如 "tools/nineGridTool/client.js" */
  clientScriptPath?: string;
  /** 处理来自 webview 的消息 */
  handleMessage(msg: any, ctx: ToolContext): Promise<void> | void;
  /** 额外允许 webview 加载资源的本地目录（如商品图片目录），面板创建时收集 */
  resourceRoots?(storageDir: string): string[];
}

export interface ToolMeta {
  toolName: string;
  title: string;
  /** 相对 src 根目录的路径字符串，运行期再解析为 Uri */
  fragmentPath?: string;
  clientScriptPath?: string;
  resourceRoots?: (storageDir: string) => string[];
}

class ToolRegistry {
  private tools: ToolMeta[] = [];
  private handlerMap = new Map<string, (msg: any, ctx: ToolContext) => void | Promise<void>>();
  private toolPanel: vscode.WebviewPanel | undefined;
  private currentToolName = "home";
  private lastToolName = "home";
  private extensionUri: vscode.Uri | undefined;

  register(tool: ToolDefinition) {
    this.handlerMap.set(tool.toolName, tool.handleMessage);
    this.tools.push({
      toolName: tool.toolName,
      title: tool.title,
      fragmentPath: tool.fragmentPath,
      clientScriptPath: tool.clientScriptPath,
      resourceRoots: tool.resourceRoots,
    });
  }

  private resolveSrc(rel?: string): vscode.Uri | undefined {
    if (!rel || !this.extensionUri) {
      return undefined;
    }
    return vscode.Uri.joinPath(this.extensionUri, "src", ...rel.split("/"));
  }

  openPanel(context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
    if (this.toolPanel) {
      this.toolPanel.reveal(vscode.ViewColumn.One);
      return;
    }
    const toolList = this.tools;
    const storageDir =
      vscode.workspace.getConfiguration("cherysis").get<string>("storageDir", "").trim() ||
      context.globalStorageUri.fsPath;
    const resourceRoots = [
      vscode.Uri.joinPath(context.extensionUri, "src", "webview"),
      vscode.Uri.joinPath(context.extensionUri, "src", "tools"),
      vscode.Uri.file(storageDir),
    ];
    for (const t of toolList) {
      if (t.resourceRoots) {
        try {
          for (const p of t.resourceRoots(storageDir)) {
            if (p && p.trim()) {
              resourceRoots.push(vscode.Uri.file(p.trim()));
            }
          }
        } catch {
          /* 忽略单工具的根目录收集失败 */
        }
      }
    }
    const panel = (this.toolPanel = vscode.window.createWebviewPanel(
      "cherysisToolPanel",
      "Cherysis‑tools 小工具集",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: resourceRoots,
      },
    ));

    const mainHtmlPath = vscode.Uri.joinPath(
      context.extensionUri,
      "src",
      "webview",
      "main.html",
    );
    panel.webview.html = fs.readFileSync(mainHtmlPath.fsPath, "utf-8");

    panel.webview.onDidReceiveMessage(async (msg) => {
      // 数据存储目录：优先用用户配置的 cherysis.storageDir，留空则退回 VS Code 全局存储目录
      const configured = vscode.workspace.getConfiguration("cherysis").get<string>("storageDir", "");
      const storageDir = configured.trim() || context.globalStorageUri.fsPath;
      fs.mkdirSync(storageDir, { recursive: true });
      const ctx = createToolContext(
        panel,
        context.extensionUri,
        storageDir,
      );

      switch (msg.type) {
        case "init": {
          panel.webview.postMessage({ type: "log", text: `🗂数据存储目录：${storageDir}` });
          panel.webview.postMessage({
            type: "initToolList",
            toolList: toolList.map((t) => {
              // 只能把 html 脚本能访问的信息传过去，clientScriptUri 需要在 switchFragment 时处理
              return { toolName: t.toolName, title: t.title };
            }),
          });
          // webview 重载（关闭面板再开 / 后台回收）后自动回到上次用的工具，数据自动重新读取
          if (this.lastToolName && this.lastToolName !== "home") {
            panel.webview.postMessage({ type: "autoOpenTool", toolName: this.lastToolName });
          }
          break;
        }
        case "switchTool": {
          const meta = toolList.find((x) => x.toolName === msg.toolName);
          const fragmentUri = meta && this.resolveSrc(meta.fragmentPath);
          if (!meta || meta.toolName === "home" || !fragmentUri) {
            break;
          }
          this.currentToolName = meta.toolName;
          this.lastToolName = meta.toolName;
          const fragHtml = fs.readFileSync(fragmentUri.fsPath, "utf-8");
          const clientScriptUri = this.resolveSrc(meta.clientScriptPath);
          panel.webview.postMessage({
            type: "switchFragment",
            html: fragHtml,
            clientScript: clientScriptUri
              ? {
                  // 转成 webview 可加载的 URI
                  uri: panel.webview.asWebviewUri(clientScriptUri).toString(),
                  toolName: meta.toolName,
                }
              : undefined,
          });
          break;
        }
        default: {
          // 工具专属消息：优先用 msg.toolName，否则回退到当前激活工具
          const toolName = msg.toolName || this.currentToolName;
          const handler = this.handlerMap.get(toolName);
          if (handler) {
            try {
              await handler(msg, ctx);
            } catch (err: any) {
              panel.webview.postMessage({
                type: "log",
                text: `❌异常:${err.message}`,
              });
            }
          } else {
            panel.webview.postMessage({
              type: "log",
              text: `❌未处理的消息类型:${msg.type}`,
            });
          }
          break;
        }
      }
    });

    panel.onDidDispose(() => {
      this.toolPanel = undefined;
    });
  }
}

export const toolRegistry = new ToolRegistry();
