import { Handler, HandlerCtx } from "./types.js";

// 设置域：选择图片根目录、保存设置项、全量刷新
export function settingsHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log } = h;
  const ctx = h.ctx;

  return {
    async pickImageDir() {
      const picked = await ctx.selectFolder(
        "选择商品图片根目录（每商品一个文件夹，内放 {编号}_{序号}.jpg）",
      );
      if (picked) {
        db.setSetting("image_dir", picked);
        log(`🖼图片根目录已设为：${picked}`);
        h.loadAll();
      }
    },

    saveSettings(msg) {
      const key = String(msg.key ?? "");
      const allowedKeys = new Set(["image_dir", "name_template", "stock_alert", "col_visible_list", "col_visible_gallery", "live_out_dir"]);
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
  };
}