import * as vscode from "vscode";
import * as fs from "fs";
import { createToolContext, ToolContext } from "./toolContext.js";

/** 工具所属分组：system=系统管理（带数据库等重依赖），utility=小工具 */
export type ToolCategory = "system" | "utility";

/**
 * 数据存储目录：优先用用户配置的 cherysis.storageDir，留空则退回 VS Code 全局存储目录。
 * 面板创建、每条消息、以及需要自己碰数据库的命令都要用同一份口径，抽出来避免各处抄一遍
 * 抄歪（抄歪的后果是「面板和命令连的不是同一个库」）。
 */
export function resolveStorageDir(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace
    .getConfiguration("cherysis")
    .get<string>("storageDir", "")
    .trim();
  return configured || context.globalStorageUri.fsPath;
}

/** 每个工具必须导出的定义 */
export interface ToolDefinition {
  toolName: string;
  title: string;
  /** 侧边栏树视图分组：系统管理 / 小工具 */
  category: ToolCategory;
  /** fragment.html 相对 src 根目录的路径，如 "tools/imageBatchTool/fragment.html" */
  fragmentPath?: string;
  /** 工具专属前端脚本 client.js 的相对路径（可选），如 "tools/nineGridTool/client.js"；可传数组按序加载 */
  clientScriptPath?: string | string[];
  /** 处理来自 webview 的消息 */
  handleMessage(msg: any, ctx: ToolContext): Promise<void> | void;
  /** 额外允许 webview 加载资源的本地目录（如商品图片目录），面板创建时收集 */
  resourceRoots?(storageDir: string): string[];
}

export interface ToolMeta {
  toolName: string;
  title: string;
  category: ToolCategory;
  /** 相对 src 根目录的路径字符串，运行期再解析为 Uri */
  fragmentPath?: string;
  clientScriptPath?: string | string[];
  resourceRoots?: (storageDir: string) => string[];
}

class ToolRegistry {
  private tools: ToolMeta[] = [];
  private handlerMap = new Map<string, (msg: any, ctx: ToolContext) => void | Promise<void>>();
  private toolPanel: vscode.WebviewPanel | undefined;
  private currentToolName = "home";
  private lastToolName = "home";
  private extensionUri: vscode.Uri | undefined;
  private panelContext: vscode.ExtensionContext | undefined;

  /** 侧边栏树视图等外部入口要读取的全部工具元信息 */
  get toolList(): ReadonlyArray<ToolMeta> {
    return this.tools;
  }

  register(tool: ToolDefinition) {
    this.handlerMap.set(tool.toolName, tool.handleMessage);
    this.tools.push({
      toolName: tool.toolName,
      title: tool.title,
      category: tool.category,
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

  /** 后端侧直接切换到某个工具并渲染 fragment（树视图 / 命令共用，webview 无需回传） */
  private switchTo(meta: ToolMeta) {
    const panel = this.toolPanel;
    const fragmentUri = this.resolveSrc(meta.fragmentPath);
    if (!panel || !fragmentUri) {
      return;
    }
    this.currentToolName = meta.toolName;
    this.lastToolName = meta.toolName;
    const fragHtml = fs.readFileSync(fragmentUri.fsPath, "utf-8");
    const clientRels = Array.isArray(meta.clientScriptPath)
      ? meta.clientScriptPath
      : meta.clientScriptPath
        ? [meta.clientScriptPath]
        : [];
    const clientUris = clientRels
      .map((rel) => this.resolveSrc(rel))
      .filter((u): u is vscode.Uri => !!u);
    panel.webview.postMessage({
      type: "switchFragment",
      html: fragHtml,
      toolName: meta.toolName,
      clientScript: clientUris.length
        ? {
            // 转成 webview 可加载的 URI，按序加载
            uris: clientUris.map((u) => panel.webview.asWebviewUri(u).toString()),
            toolName: meta.toolName,
          }
        : undefined,
    });
  }

  /** 侧边栏树视图/命令入口：打开面板并切换到指定工具；面板不存在时等 webview 就绪后自动恢复 */
  openTool(toolName: string, context?: vscode.ExtensionContext) {
    if (context) {
      this.extensionUri = context.extensionUri;
      this.panelContext = context;
    }
    const meta = this.tools.find((x) => x.toolName === toolName);
    if (!meta || toolName === "home") {
      return;
    }
    if (this.toolPanel) {
      this.toolPanel.reveal(vscode.ViewColumn.One);
      if (this.currentToolName !== toolName) {
        this.switchTo(meta);
      }
      return;
    }
    // 面板尚未创建：记住目标工具，openPanel 的 init 会透过 autoOpenTool 自动切过去
    this.lastToolName = meta.toolName;
    if (this.panelContext) {
      this.openPanel(this.panelContext);
    }
  }

  openPanel(context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
    this.panelContext = context;
    if (this.toolPanel) {
      this.toolPanel.reveal(vscode.ViewColumn.One);
      return;
    }
    const toolList = this.tools;
    const storageDir = resolveStorageDir(context);
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
      const storageDir = resolveStorageDir(context);
      fs.mkdirSync(storageDir, { recursive: true });
      const ctx = createToolContext(
        panel,
        context.extensionUri,
        storageDir,
        context.globalStorageUri.fsPath,
        // 本机偏好走 globalState（C 盘 state.vscdb），与共享的 storageDir 无关
        context.globalState,
      );

      switch (msg.type) {
        case "init": {
          panel.webview.postMessage({ type: "log", text: `🗂数据存储目录：${storageDir}` });
          panel.webview.postMessage({
            type: "initToolList",
            toolList: toolList.map((t) => {
              // 只能把 html 脚本能访问的信息传过去，clientScriptUri 需要在 switchFragment 时处理
              return { toolName: t.toolName, title: t.title, category: t.category };
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
          if (!meta || meta.toolName === "home" || !this.resolveSrc(meta.fragmentPath)) {
            break;
          }
          this.switchTo(meta);
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
