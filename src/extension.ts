import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  runImageBatchTool,
  openFolderInExplorer,
} from "./tools/imageBatchTool";

type LogCallback = (msg: string) => void;
type ToolHandler = (params: any, log: LogCallback) => Promise<void>;

interface ToolMeta {
  toolName: string;
  title: string;
  fragmentUri?: vscode.Uri;
}

export function activate(context: vscode.ExtensionContext) {
  // ============工具注册中心 ============
  const TOOL_LIST: ToolMeta[] = [
    {
      toolName: "home",
      title: "🏠首页",
      // home 不需要fragment，去掉
    },
    {
      toolName: "imageBatchTool",
      title: "🖼图片批量工具箱",
      fragmentUri: vscode.Uri.joinPath(
        context.extensionUri,
        "src",
        "webview",
        "fragments",
        "imageBatchTool.fragment.html",
      ),
    },
  ];

  const toolHandlerMap = new Map<string, ToolHandler>();
  toolHandlerMap.set("imageBatchTool", runImageBatchTool);

  let toolPanel: vscode.WebviewPanel | undefined;
  const openPanel = vscode.commands.registerCommand(
    "cherysis-tools.openToolPanel",
    () => {
      if (toolPanel) {
        toolPanel.reveal(vscode.ViewColumn.One);
        return;
      }
      toolPanel = vscode.window.createWebviewPanel(
        "cherysisToolPanel",
        "Cherysis-tools 小工具集",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "src", "webview"),
          ],
        },
      );

      const mainHtmlPath = vscode.Uri.joinPath(
        context.extensionUri,
        "src",
        "webview",
        "main.html",
      );
      toolPanel.webview.html = fs.readFileSync(mainHtmlPath.fsPath, "utf-8");

      //消息总路由
      toolPanel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          //前端初始化，下发工具列表渲染导航
          case "init": {
            toolPanel?.webview.postMessage({
              type: "initToolList",
              toolList: TOOL_LIST,
            });
            break;
          }
          //切换工具
          case "switchTool": {
            const meta = TOOL_LIST.find((x) => x.toolName === msg.toolName);
            if (!meta) {
              return;
            }
            // ✅home直接返回，不加载fragment
            if (meta.toolName === "home") {
              break;
            }
            if (!meta.fragmentUri) {
              return;
            }
            const fragHtml = fs.readFileSync(meta.fragmentUri.fsPath, "utf-8");
            toolPanel?.webview.postMessage({
              type: "switchFragment",
              html: fragHtml,
            });
            break;
          }
          //文件夹选择弹窗
          case "selectFolder": {
            const res = await vscode.window.showOpenDialog({
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
            });
            if (res && res.length > 0) {
              toolPanel?.webview.postMessage({
                type: "folderSelected",
                path: res[0].fsPath,
                targetId: msg.targetId,
              });
            }
            break;
          }
          //执行工具处理器
          case "runTool": {
            const handler = toolHandlerMap.get(msg.toolName);
            if (!handler) {
              toolPanel?.webview.postMessage({
                type: "log",
                text: `❌未注册工具:${msg.toolName}`,
              });
              return;
            }
            try {
              toolPanel?.webview.postMessage({
                type: "log",
                text: `▶开始执行工具:${msg.toolName}`,
              });
              await handler(msg.params, (logText: string) => {
                toolPanel?.webview!.postMessage({
                  type: "log",
                  text: logText,
                });
              });
              toolPanel?.webview.postMessage({
                type: "log",
                text: "✅工具执行完成",
              });
            } catch (err: any) {
              toolPanel?.webview.postMessage({
                type: "log",
                text: `❌异常:${err.message}`,
              });
            }
            break;
          }
          case "openTargetFolder": {
            const p = msg.targetPath;
            try {
              await openFolderInExplorer(p);
            } catch (e: any) {
              toolPanel?.webview.postMessage({
                type: "log",
                text: `[错误]打开文件夹失败：${e.message}`,
              });
            }
            break;
          }
        }
      });

      toolPanel.onDidDispose(() => {
        toolPanel = undefined;
      });
    },
  );
  context.subscriptions.push(openPanel);
}

export function deactivate() {}
