import * as vscode from "vscode";
import { Handler, HandlerCtx } from "./types.js";

// 设置域：保存设置项、全量刷新
// 注：商品图片根目录**不在这里**——它是跟人走的路径，存本机 VS Code 设置
// （cherysis.shopTool.imageDir），入口是命令面板的「Cherysis:设置商品图片根目录」。
// 见 ../imageDir.ts。
export function settingsHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log } = h;

  return {
    saveSettings(msg) {
      const key = String(msg.key ?? "");
      // image_dir 不在其中：它存在本机 VS Code 设置里，这里收到也一律拒掉——
      // 收下就等于把它写回共享库，正是多人互相覆盖的根源
      const allowedKeys = new Set(["name_template", "stock_alert", "sales_deduct_stock", "row_height", "font_size", "col_visible_list", "col_visible_gallery", "col_image_list", "col_image_gallery", "col_show_ops", "live_out_dir", "live_grid_label"]);
      if (!allowedKeys.has(key)) {
        log("❌不支持的设置项: " + key);
        return;
      }
      db.setSetting(key, String(msg.value ?? ""));
      log("⚙️设置已保存");
      h.loadAll();
    },

    loadAll() {
      h.loadAll();
    },

    // 「📁 更换…」按钮：把命令叫起来。选目录/校验/关旧连接/清撤销快照全在命令里
    // （见 extension.ts 的 Cherysis.setStorageDir），这里一行都不重复实现。
    async pickStorageDir() {
      try {
        await vscode.commands.executeCommand("Cherysis.setStorageDir");
      } catch (err: any) {
        log(`❌打开目录选择失败：${err?.message ?? err}`);
      }
    },
  };
}