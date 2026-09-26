import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { toolRegistry, resolveStorageDir } from "./core/toolRegistry.js";
import { toolTreeProvider } from "./webview/toolTree.js";
import { imageBatchTool } from "./tools/imageBatchTool/index.js";
import { nineGridTool } from "./tools/nineGridTool/index.js";
import { excelAnalyzeTool } from "./tools/excelAnalyzeTool/index.js";
import { procurementTool } from "./tools/procurementTool/index.js";
import { shopTool } from "./tools/shopTool/index.js";
import { order1688Tool } from "./tools/order1688Tool/index.js";
import {
  clearConfigImageDir,
  configScope,
  isValidImageDir,
  setConfigImageDir,
} from "./tools/shopTool/imageDir.js";
import { getDB, initDB, closeDB } from "./tools/shopTool/db.js";
import { closeDB as closeProcurementDB } from "./tools/procurementTool/db.js";
import { resetProcurementUndoRedo } from "./tools/procurementTool/index.js";
import { closeDB as closeOrder1688DB } from "./tools/order1688Tool/db.js";
import { resetShopUndoRedo } from "./tools/shopTool/index.js";

const IMAGE_DIR_SECTION = "cherysis.shopTool";
const IMAGE_DIR_KEY = "imageDir";
const STORAGE_DIR_SECTION = "cherysis";
const STORAGE_DIR_KEY = "storageDir";

/** 目录里已有一份 shop.db？用于换库时区分「切到共享库」和「误选了个空文件夹」 */
function shopDbIn(dir: string): { exists: boolean; size: number; mtimeMs: number } {
  try {
    const st = fs.statSync(path.join(dir, "shop.db"));
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

/** 当前生效的本机设置值（工作区覆盖优先，与 VS Code 自己显示的一致） */
function readConfigImageDir(): string {
  return String(
    vscode.workspace
      .getConfiguration(IMAGE_DIR_SECTION)
      .get<string>(IMAGE_DIR_KEY, "")
      .trim(),
  );
}

/** 库里那份「全组共享」的遗留旧值；库还打不开时返回空串 */
function readLegacyImageDir(storageDir: string): string {
  try {
    initDB(storageDir);
    return String(getDB().getSetting("image_dir") || "").trim();
  } catch {
    return "";
  }
}

function registerShopImageDirCommands(context: vscode.ExtensionContext): void {
  const storageDir = (): string => resolveStorageDir(context);

  context.subscriptions.push(
    // VS Code 的设置界面没有文件夹选择器，命令面板是唯一能「点选目录」的地方
    // （工具面板里刻意不放：路径是本机环境的一部分，跟其他共享设置混在一起容易被人当成全组配置去改）
    vscode.commands.registerCommand("Cherysis.setShopImageDir", async () => {
      const picked = await vscode.window.showOpenDialog({
        title: "选择商品图片根目录（每商品一个文件夹，内放 {编号}_{序号}.jpg）",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const dir = picked[0].fsPath;
      // 工作区设置优先级高于用户设置：先说清楚，否则用户写完发现没生效
      if (configScope() === "workspace") {
        const anyway = await vscode.window.showWarningMessage(
          "该配置被工作区设置（.vscode/settings.json）覆盖，写入用户设置不会生效。",
          {
            modal: true,
            detail: `当前生效的（来自工作区）：${readConfigImageDir()}\n你选的：${dir}`,
          },
          "仍然写入",
        );
        if (anyway !== "仍然写入") {
          return;
        }
      }
      await setConfigImageDir(dir);
      // 库里那份共享旧值只清一次：留着的话，没设自己路径的人会一直悄悄继承别人机器上的路径
      const legacy = readLegacyImageDir(storageDir());
      if (legacy) {
        try {
          getDB().setSetting("image_dir", "");
        } catch (err: any) {
          vscode.window.showWarningMessage(
            `已写入本机设置，但清不掉共享库里的旧值：${err.message}`,
          );
        }
      }
      vscode.window.showInformationMessage(
        `🖼商品图片根目录已设为：${dir}（只影响本机，重开工具面板后生效）`,
      );
    }),

    vscode.commands.registerCommand("Cherysis.resetShopImageDir", async () => {
      const legacy = readLegacyImageDir(storageDir());
      const confirm = await vscode.window.showWarningMessage("要清除本机的商品图片根目录设置吗？", {
        modal: true,
        detail: legacy
          ? `清除后会改用共享库里的值：${legacy}`
          : "清除后本机没有商品图片根目录，商品图片将无法显示/上传/删除。",
      });
      if (confirm !== "清除") {
        return;
      }
      await clearConfigImageDir();
      vscode.window.showInformationMessage(
        legacy
          ? "⚙️已清除本机设置，现在改用共享库里的值（重开工具面板后生效）"
          : "⚙️已清除本机设置。商品图片根目录现在为空，商品图片将无法显示/上传/删除。",
      );
    }),
  );

  // 配置被改成不可用的值时提醒一次。面板里已经没有这行设置了，通知是唯一即时反馈。
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(`${IMAGE_DIR_SECTION}.${IMAGE_DIR_KEY}`)) {
        return;
      }
      const dir = readConfigImageDir();
      if (dir && !isValidImageDir(dir)) {
        await vscode.window.showWarningMessage(`⚠ 商品图片根目录不可用：${dir}`, {
          detail: "必须是绝对路径且真实存在（如 Z:\\商品图片 或 \\\\NAS\\share\\商品图）。修好后本机才能显示/上传/删除商品图片；也可以执行命令「Cherysis:设置商品图片根目录」重新选择。",
        });
      }
    }),
  );
}

function registerStorageDirCommands(context: vscode.ExtensionContext): void {
  // 和商品图片根目录同一个思路：VS Code 设置界面没有文件夹选择器，命令面板
  // （以及工具面板里那一行的按钮）是唯一能「点选目录」的地方，面板里刻意不给输入框。
  context.subscriptions.push(
    vscode.commands.registerCommand("Cherysis.setStorageDir", async () => {
      const current = resolveStorageDir(context);
      const picked = await vscode.window.showOpenDialog({
        title: "选择商品数据库所在目录（里面放 shop.db，多台电脑可指向同一份）",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: fs.existsSync(current) ? vscode.Uri.file(current) : undefined,
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const dir = picked[0].fsPath;
      if (path.resolve(dir) === path.resolve(current)) {
        vscode.window.showInformationMessage("⚙️选的就是当前目录，没有改动。");
        return;
      }
      // 手滑防护：选到一个没有 shop.db 的文件夹 = 切过去会新建一个空库，
      // 原数据看着「全没了」。先说清楚，让用户确认。
      const target = shopDbIn(dir);
      if (!target.exists) {
        const go = await vscode.window.showWarningMessage(
          `该目录下没有 shop.db，切过去会新建一个空数据库。`,
          {
            modal: true,
            detail: `当前：${current}\n你选的：${dir}\n\n确定要新建空库吗？商品/库存/销售/月报都会是空的。`,
          },
          "仍然新建",
        );
        if (go !== "仍然新建") {
          return;
        }
      }
      await vscode.workspace
        .getConfiguration(STORAGE_DIR_SECTION)
        .update(STORAGE_DIR_KEY, dir, vscode.ConfigurationTarget.Global);
      // 关键：initDB 见到已开的连接就直接 return，光改设置不重载等于没切。
      // 三个工具各有各的库单例，采购/订单的也一起关，否则它们会继续连在旧库文件上。
      // 顺带把两个工具的撤销/重做快照丢干净——里面是旧库的行 id，restoreAll 照着写会把新库写烂。
      closeDB();
      resetShopUndoRedo();
      closeProcurementDB();
      resetProcurementUndoRedo();
      closeOrder1688DB();
      vscode.window.showInformationMessage(
        target.exists
          ? `🗂商品数据库目录已设为：${dir}\n重开工具面板后生效。`
          : `🗂商品数据库目录已设为：${dir}（将新建一个空库）\n重开工具面板后生效。`,
      );
    }),
  );
}

export function activate(context: vscode.ExtensionContext) {
  console.log("✅========Cherysis 插件已经activate激活========");

  toolRegistry.register(imageBatchTool);
  toolRegistry.register(nineGridTool);
  toolRegistry.register(excelAnalyzeTool);
  toolRegistry.register(procurementTool);
  toolRegistry.register(shopTool);
  toolRegistry.register(order1688Tool);

  context.subscriptions.push(
    vscode.commands.registerCommand("Cherysis.openToolPanel", () => {
      toolRegistry.openPanel(context);
    }),
    vscode.commands.registerCommand(
      "Cherysis.openTool",
      (toolName: string | undefined) => {
        if (toolName) {
          toolRegistry.openTool(toolName, context);
        }
      },
    ),
    vscode.window.createTreeView("cherysis.tools", {
      treeDataProvider: toolTreeProvider,
    }),
  );

  registerShopImageDirCommands(context);
  registerStorageDirCommands(context);
}

export function deactivate() {}
