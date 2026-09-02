import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import {
  runImageBatchTool,
  openFolderInExplorer,
} from "./tools/imageBatchTool.js";
import {
  handleNineGridMergeFromList,
  handleNineGridLabel,
  rotateImageInPlace,
  scanImageFiles,
} from "./tools/nineGridTool.js";
type LogCallback = (msg: string) => void;
type ToolHandler = (params: any, log: LogCallback) => Promise<void>;
interface ToolMeta {
  toolName: string;
  title: string;
  fragmentUri?: vscode.Uri;
}
/** 读取本地图片，原生fs转base64 dataUrl，不使用sharp */
async function readImageToBase64(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  let mime = "image/jpeg";
  if (ext === ".png") mime = "image/png";
  else if (ext === ".webp") mime = "image/webp";
  else if (ext === ".bmp") mime = "image/bmp";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
export function activate(context: vscode.ExtensionContext) {
  console.log("✅========Cherysis 插件已经activate激活========");
  // ============工具注册中心 ============
  const TOOL_LIST: ToolMeta[] = [
    {
      toolName: "home",
      title: "🏠首页",
    },
    {
      toolName: "imageBatchTool",
      title: "🗂️图片批量工具箱",
      fragmentUri: vscode.Uri.joinPath(
        context.extensionUri,
        "src",
        "webview",
        "fragments",
        "imageBatchTool.fragment.html",
      ),
    },
    {
      toolName: "nineGridTool",
      title: "🧩九宫格工具箱",
      fragmentUri: vscode.Uri.joinPath(
        context.extensionUri,
        "src",
        "webview",
        "fragments",
        "nineGrid.fragment.html",
      ),
    },
  ];
  const toolHandlerMap = new Map<string, ToolHandler>();
  toolHandlerMap.set("imageBatchTool", runImageBatchTool);
  let toolPanel: vscode.WebviewPanel | undefined;
  // key:磁盘路径 value:base64 dataUrl
  let nineGridImgUriMap = new Map<string, string>();
  const openPanel = vscode.commands.registerCommand(
    "Cherysis.openToolPanel",
    () => {
      if (toolPanel) {
        toolPanel.reveal(vscode.ViewColumn.One);
        return;
      }
      toolPanel = vscode.window.createWebviewPanel(
        "cherysisToolPanel",
        "Cherysis‑tools 小工具集",
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
      const htmlContent = fs.readFileSync(mainHtmlPath.fsPath, "utf-8");
      toolPanel.webview.html = htmlContent;
      toolPanel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case "init": {
            toolPanel?.webview.postMessage({
              type: "initToolList",
              toolList: TOOL_LIST,
            });
            break;
          }
          case "switchTool": {
            const meta = TOOL_LIST.find((x) => x.toolName === msg.toolName);
            if (!meta) {
              return;
            }
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
          case "openLoadImageFolder": {
            const folderUri = await vscode.window.showOpenDialog({
              canSelectFolders: true,
              canSelectFiles: false,
            });
            if (!folderUri) {
              break;
            }
            const dir = folderUri[0].fsPath;
            const imgPaths = await scanImageFiles(dir);
            nineGridImgUriMap.clear();
            for (const fp of imgPaths) {
              const base64Url = await readImageToBase64(fp);
              nineGridImgUriMap.set(fp, base64Url);
            }
            toolPanel?.webview.postMessage({
              type: "addImagePaths",
              paths: imgPaths,
              uriMap: Object.fromEntries(nineGridImgUriMap),
            });
            break;
          }
          case "openSelectImages": {
            const uris = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: true,
              filters: {
                图片: ["jpg", "jpeg", "png", "bmp", "webp"],
              },
            });
            if (!uris) {
              break;
            }
            const imgPaths: string[] = [];
            nineGridImgUriMap.clear();
            for (const u of uris) {
              imgPaths.push(u.fsPath);
              const base64Url = await readImageToBase64(u.fsPath);
              nineGridImgUriMap.set(u.fsPath, base64Url);
            }
            toolPanel?.webview.postMessage({
              type: "addImagePaths",
              paths: imgPaths,
              uriMap: Object.fromEntries(nineGridImgUriMap),
            });
            break;
          }
          case "selectOutputFolder": {
            const folderUri = await vscode.window.showOpenDialog({
              canSelectFolders: true,
            });
            if (!folderUri) {
              break;
            }
            toolPanel?.webview.postMessage({
              type: "setOutputDir",
              path: folderUri[0].fsPath,
            });
            break;
          }
          case "openMergeOutputFolder": {
            const outDir = msg.outDir?.trim();
            if (!outDir) {
              vscode.window.showErrorMessage("请先选择输出文件夹");
              return;
            }
            try {
              const uri = vscode.Uri.file(outDir);
              await vscode.commands.executeCommand("revealFileInOS", uri);
            } catch (err) {
              vscode.window.showErrorMessage(
                `文件夹打开失败：${(err as Error).message}`,
              );
            }
            break;
          }
          case "openLabelOutputFolder": {
            const targetDir = msg.targetDir?.trim();
            if (!targetDir) {
              vscode.window.showErrorMessage("请先选择输出文件夹");
              return;
            }
            try {
              const uri = vscode.Uri.file(targetDir);
              await vscode.commands.executeCommand("revealFileInOS", uri);
            } catch (err) {
              vscode.window.showErrorMessage(
                `文件夹打开失败：${(err as Error).message}`,
              );
            }
            break;
          }

          case "selectLabelOutDir": {
            const folderUri = await vscode.window.showOpenDialog({
              canSelectFolders: true,
            });
            if (!folderUri) {
              break;
            }
            toolPanel?.webview.postMessage({
              type: "setLabelOutDir",
              path: folderUri[0].fsPath,
            });
            break;
          }
          case "rotateImage": {
            const idx = msg.idx;
            const grid = msg.grid;
            const fp = grid[idx];
            if (!fp) {
              vscode.window.showErrorMessage("当前格子没有图片");
              toolPanel?.webview.postMessage({
                type: "log",
                text: "⚠旋转：当前格子没有图片",
              });
              break;
            }
            try {
              await rotateImageInPlace(fp);
              // 旋转完成，重新读取磁盘拿到新base64
              const newBase64 = await readImageToBase64(fp);
              const msgText = `✅旋转完成: ${fp}`;
              vscode.window.showInformationMessage(msgText);
              //下发自定义消息，携带新base64
              toolPanel?.webview.postMessage({
                type: "rotatedCellUpdate",
                idx: idx,
                filePath: fp,
                newBase64: newBase64,
              });
              toolPanel?.webview.postMessage({ type: "log", text: msgText });
            } catch (err: any) {
              const errText = `❌旋转失败：${String(err)}`;
              vscode.window.showErrorMessage(errText);
              toolPanel?.webview.postMessage({ type: "log", text: errText });
            }
            break;
          }
          case "runMerge": {
            // 执行拼图前清空日志
            toolPanel?.webview.postMessage({ type: "clearLog" });
            toolPanel?.webview.postMessage({
              type: "log",
              text: "▶开始执行九宫格拼图",
            });
            const imgPaths: string[] = msg.grid.filter(
              (x: string | null): x is string => x !== null,
            );
            if (imgPaths.length !== 9) {
              vscode.window.showErrorMessage("网格必须填满9张图片");
              toolPanel?.webview.postMessage({
                type: "log",
                text: "❌失败：网格必须填满9张图片",
              });
              return;
            }
            if (!msg.outDir || !fs.existsSync(msg.outDir)) {
              vscode.window.showErrorMessage("请选择有效输出文件夹");
              toolPanel?.webview.postMessage({
                type: "log",
                text: "❌失败：请选择有效输出文件夹",
              });
              return;
            }
            try {
              const outFile = await handleNineGridMergeFromList(
                imgPaths,
                msg.outDir,
              );
              vscode.window.showInformationMessage(`拼图完成：${outFile}`);
              toolPanel?.webview.postMessage({
                type: "log",
                text: `✅拼图完成，输出文件：${outFile}`,
              });
            } catch (err: any) {
              toolPanel?.webview.postMessage({
                type: "log",
                text: `❌拼图异常：${err.message}`,
              });
            }
            break;
          }
          case "selectLabelImage": {
            const uri = await vscode.window.showOpenDialog({
              canSelectMany: false,
              filters: {
                图片: ["jpg", "jpeg", "png", "bmp", "webp"],
              },
            });
            if (!uri) {
              break;
            }
            const filePath = uri[0].fsPath;
            const base64Url = await readImageToBase64(filePath);
            toolPanel?.webview.postMessage({
              type: "setLabelImage",
              path: filePath,
              base64: base64Url,
            });
            break;
          }
          case "runLabel": {
            // 执行序号生成前清空日志
            toolPanel?.webview.postMessage({ type: "clearLog" });
            toolPanel?.webview.postMessage({
              type: "log",
              text: "▶开始执行图片添加序号",
            });
            const srcPath = msg.srcPath;
            const startNum = Number(msg.startNum);
            const outDir = msg.outDir;
            if (!srcPath || !fs.existsSync(srcPath)) {
              vscode.window.showErrorMessage("请先选择有效九宫格图片");
              toolPanel?.webview.postMessage({
                type: "log",
                text: "❌失败：请先选择有效九宫格图片",
              });
              return;
            }
            if (isNaN(startNum) || startNum < 1) {
              vscode.window.showErrorMessage("起始编号必须是≥1整数");
              toolPanel?.webview.postMessage({
                type: "log",
                text: "❌失败：起始编号必须是≥1整数",
              });
              return;
            }
            try {
              const outFile = await handleNineGridLabel(
                srcPath,
                startNum,
                outDir,
              );
              vscode.window.showInformationMessage(`添加序号完成：${outFile}`);
              toolPanel?.webview.postMessage({
                type: "log",
                text: `✅序号生成完成，输出文件：${outFile}`,
              });
            } catch (err: any) {
              toolPanel?.webview.postMessage({
                type: "log",
                text: `❌序号生成异常：${err.message}`,
              });
            }
            break;
          }
          case "showNotify": {
            vscode.window.showInformationMessage(msg.text);
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
