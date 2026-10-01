import { Handler, HandlerCtx } from "./types.js";

// 设置域：保存设置项、全量刷新
// 注：商品图片根目录**不在这里**——它是跟人走的路径，存本机 VS Code 设置
// （cherysis.shopTool.imageDir），入口是命令面板的「Cherysis:设置商品图片根目录」。
// 见 ../imageDir.ts。
//
// 行高/字号/字段显隐/导入导出勾选/九宫格输出目录这些**同样不在这里**——
// 它们也是各人各设的偏好，一律落本机 globalState（分流见 index.ts LOCAL_PREF_KEYS）。
// 留在这张表里的只有全组共用的业务规则。
export function settingsHandlers(h: HandlerCtx): Record<string, Handler> {
  const { db, log } = h;

  return {
    async saveSettings(msg) {
      const key = String(msg.key ?? "");
      // image_dir 不在表里：它存在本机 VS Code 设置里，这里收到也一律拒掉——
      // 收下就等于把它写回共享库，正是多人互相覆盖的根源。
      // 同样拒掉的还有 17 个个人偏好键：它们由 setSetting 自动分流到 globalState，
      // 不该有人能从面板往共享库里塞（那正是当初 image_dir 的老毛病）。
      const sharedOnly = new Set(["name_template", "stock_alert", "sales_deduct_stock"]);
      if (sharedOnly.has(key)) {
        await h.setSetting(key, String(msg.value ?? ""));
        log("⚙️设置已保存（全组共享）");
        h.loadAll();
        return;
      }
      if (h.localPrefKey(key)) {
        await h.setSetting(key, String(msg.value ?? ""));
        log("⚙️设置已保存（只影响本机）");
        // 本机键不碰共享库，没必要为了改个字号把整库重载一遍
        // （共享盘上 loadAll 是几十次网络往返，调一次字号发两条消息就是白等两轮）
        h.postLocalPrefs();
        return;
      }
      log("❌不支持的设置项: " + key);
    },

    loadAll() {
      // 汇总缓存（累计售出/退款）只在首次查库，ensureAggLoaded 有本机内存缓存。
      // 别人写完库后点 🔄，不先清它，列表里的累计数会一直停在面板打开那一刻。
      db.clearAggCache();
      h.loadAll();
    },

    /** 顶栏 🔒/🔓 开关：本机持久化，只存在 globalState 里，别的机器看不见 */
    async setReadOnly(msg) {
      const on = msg?.value === true || msg?.value === 1 || msg?.value === "1";
      await h.ctx.prefs.update("readOnly", on);
      h.post({ type: "readOnlyChanged", readOnly: on });
      log(
        on
          ? "🔒 已切到只读：商品/销售/结算/图片/排品的写入全部拦下；读取、🔄 刷新、导出、生成九宫格和星标总览照常可用"
          : "🔓 已解除只读：现在会写共享库了。同一时间只让一台机器开着写",
      );
    },

    // 「📁 更换…」按钮：把命令叫起来。选目录/校验/关旧连接/清撤销快照全在命令里
    // （见 extension.ts 的 Cherysis.setStorageDir），这里一行都不重复实现。
    async pickStorageDir() {
      try {
        await h.ctx.pickStorageDir();
      } catch (err: any) {
        log(`❌打开目录选择失败：${err?.message ?? err}`);
      }
    },
  };
}
