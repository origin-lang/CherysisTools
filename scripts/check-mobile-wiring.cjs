// 手机版「接线」核对：两件在真机上才暴露、而且都不报错的事。
//
// ① DOM id：app.js 里 `$("xxx")` 用到的每个 id，必须在 index.html 里真的存在。
//    前端三件套是静态直出、不编译也不打包：改 HTML 时把 id 改了名、或者 app.js 里手滑写错
//    一个字母，**不会报任何错** —— 表现是"这个按钮点了没反应"。
// ② SSE 事件名：服务端发的事件名与前端监听的事件名必须完全对上。写错一个字母（"change" vs
//    "changed"）同样是静默失效 —— 界面上那个「有改动」永远不亮，而日志里什么都没有。
//
// 用法：node scripts/check-mobile-wiring.cjs
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const mobileDir = path.join(root, "src", "webview", "mobile");
const serverDir = path.join(root, "src", "server");
const jsFile = path.join(mobileDir, "app.js");
const htmlFile = path.join(mobileDir, "index.html");

/**
 * 手机版的**全部**前端脚本。app.js 是主页面；其余是**独立功能文件**（目前只有 purchase.js = 进货单）
 * —— 各自一块功能，靠 app.js 结尾那个 `window.Cherysis` 接缝通话。
 * ⚠️ 下面几处 `const js = ` 专门只读 app.js（都是主链/外壳的断言），别拿它当"全部脚本"用。
 */
const jsFiles = fs
  .readdirSync(mobileDir)
  .filter((f) => f.endsWith(".js"))
  .sort();

/** JS 动态创建、HTML 里本来就没有的 id */
// 注：套装那块（#dSetSum / #dSetListCard / dSetCount / dSetList / setAddToggle / setAddBtn / setAddCode）
// 现在**骨架全在 index.html 里**，不再由 renderSetList 拼 —— 所以不在豁免名单里，会被正常核对。
// 只有「设置页的档位输入框」是 JS 动态建的。原先还豁免 codeQ / codeQGroup
// （筛选面板里那个编号输入框）—— 2026-10-11 它并进顶部搜索行了，那两个 id 整个不存在，
// 豁免名单里留着会让这条闸门变成摆设。
const DYNAMIC_IDS = new Set(["fsInput"]);

/**
 * 服务端能发的事件名（唯一出处：events.ts 的 HubEvent 注释 + index.ts 的 publish 调用 +
 * httpHost.ts 的 sinkPost/sinkLog）。逐个都要能在 src/server 里找到，防止这里凭记忆写。
 */
const SERVER_EVENTS = ["post", "log", "changed", "reset", "queue"];

/** EventSource 自带的事件（浏览器发的，不是服务端发的）：别当成"拼错了" */
const BROWSER_EVENTS = new Set(["open", "error", "message"]);

const fails = [];
const js = fs.readFileSync(jsFile, "utf8");
const html = fs.readFileSync(htmlFile, "utf8");
const serverSrc = fs
  .readdirSync(serverDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => fs.readFileSync(path.join(serverDir, f), "utf8"))
  .join("\n");

// ---------- ① DOM id ----------
// 主页面 + 每个独立功能文件都用同一套 `$("id")` 取元素，所以**全都得核**：
// 功能文件里写错一个字母，一样是"那块点了没反应、控制台一声不响"。
const used = new Set();
for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(mobileDir, f), "utf8");
  for (const m of src.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) {
    used.add(m[1]);
  }
}
const have = new Set();
const idCount = {};
for (const m of html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)) {
  have.add(m[1]);
  idCount[m[1]] = (idCount[m[1]] || 0) + 1;
}
// ---------- ①b 重复 id ----------
// 也是"不报错"的一类，刚踩过：把 #dSetOf 挪到封面之上时，index.html 里留下了**两份**
// <div id="dCover">。$("dCover") 只会拿到第一个 —— 于是封面渲染在一处、另一个空壳占着版面
// （.cover 有 min-height，看着就是凭空多出一块空白），浏览器一句警告都不给。
for (const id of Object.keys(idCount).sort()) {
  if (idCount[id] > 1) {
    fails.push(
      `index.html 里 id="${id}" 出现了 ${idCount[id]} 次：$("${id}") 只会拿到第一个，其余是空壳（占版面、不报错）`,
    );
  }
}
if (used.size < 20) {
  fails.push(`前端脚本里只认出 ${used.size} 个 $("...")（正常应有 80 多个）：写法变了？这条闸门就失效了`);
}
for (const id of [...used].filter((i) => !have.has(i) && !DYNAMIC_IDS.has(i)).sort()) {
  fails.push(`有前端脚本用了 $("#${id}")，但 index.html 里没有 id="${id}" —— 点了没反应就是这么来的`);
}

// ---------- ② SSE 事件名 ----------
for (const name of SERVER_EVENTS) {
  if (!new RegExp(`"${name}"`).test(serverSrc)) {
    fails.push(`服务端源码里找不到事件名 "${name}"：清单该更新了（别凭记忆写在这里）`);
  }
  if (!js.includes(`addEventListener("${name}"`)) {
    fails.push(`app.js 没有监听 SSE 的 "${name}" 事件 —— 服务端发了没人接，等于没做`);
  }
}
// 反向：前端监听了服务端根本不会发的名字（十有八九是拼错）
const listened = new Set();
for (const m of js.matchAll(/es\.addEventListener\("([A-Za-z0-9_-]+)"/g)) {
  listened.add(m[1]);
}
for (const name of [...listened]) {
  if (!SERVER_EVENTS.includes(name) && !BROWSER_EVENTS.has(name)) {
    fails.push(`app.js 监听了 SSE 的 "${name}"，但服务端不会发这个事件（拼错了？）`);
  }
}
// 也不许漏接：服务端会发的几个，前端必须都接着（漏一个就少一块功能）
for (const name of SERVER_EVENTS) {
  if (!listened.has(name)) {
    fails.push(`服务端会发 "${name}"，但 app.js 里搜不到对应的监听`);
  }
}

// ---------- ③ 宽屏抽屉的断点：JS 与 CSS 必须用同一个宽度 ----------
// JS 里 isWide() 决定"进不进抽屉模式"（要不要把列表留着、给 body 加 drawer 类），
// CSS 里 @media 决定"抽屉长什么样"。两边写岔了就是一个**半坏**的界面：
// JS 以为进了抽屉（列表留着），CSS 没生效（详情还是整屏盖上去）→ 列表白留在下面。
const css = fs.readFileSync(path.join(mobileDir, "style.css"), "utf8");
const jsBreak = /function isWide\(\)[\s\S]{0,220}?min-width:\s*(\d+)px/.exec(js);
const cssBreak = /@media \(min-width:\s*(\d+)px\)\s*\{\s*:root\s*\{\s*\/\*[^*]*\*\/\s*--drawer/.exec(css);
if (!jsBreak) {
  fails.push("app.js 的 isWide() 里找不到断点宽度（写法变了？这条闸门就失效了）");
} else if (!cssBreak) {
  fails.push("style.css 里找不到定义 --drawer 的那个 @media 断点（抽屉样式被改名/挪走了？）");
} else if (jsBreak[1] !== cssBreak[1]) {
  fails.push(
    `抽屉断点两边不一致：app.js 用 ${jsBreak[1]}px，style.css 用 ${cssBreak[1]}px —— 会得到一个半坏的界面`,
  );
}
if (jsBreak && cssBreak && jsBreak[1] === cssBreak[1]) {
  // ⚠️ 必须是"选择器 + 花括号"才算数：光 includes 选择器字符串会被**注释里提到的那一句**骗过
  //    （`.screen` 和浮动底条的注释里都写过 body.drawer #tabbar），实测那样子变异自检是假绿。
  const hasRule = (sel) =>
    new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{").test(css);
  for (const need of ["body.drawer #screen-list", "body.drawer #tabbar", "body.drawer #toast"]) {
    if (!hasRule(need)) {
      fails.push(`style.css 里缺少 "${need} { }" 这条规则：抽屉会盖住那一块（分页按钮/tab 栏/提示浮层）`);
    }
  }
  // 筛选抽屉（宽屏时也从右边出）同样必须让位，否则分页按钮/tab 栏会被压住
  for (const need of [
    "body.filterdrawer #screen-list",
    "body.filterdrawer #tabbar",
    "body.filterdrawer #toast",
    "body.filterdrawer #filterPanel",
  ]) {
    if (!hasRule(need)) {
      fails.push(`style.css 里缺少 "${need} { }" 这条规则：宽屏筛选抽屉会盖住那一块或整屏铺开`);
    }
  }
  // 抽屉样式必须**同时**覆盖详情/新建/设置三屏：JS 的 keepList 里三个都有，
  // CSS 少一个就是"列表留在下面、面板整屏盖上去"的半坏界面
  if (!/#screen-detail,\s*#screen-new,\s*#screen-settings\s*\{/.test(css)) {
    fails.push(
      "style.css 的抽屉规则里应同时有 #screen-detail / #screen-new / #screen-settings（三屏都要走抽屉）",
    );
  }
  if (
    !/id === "screen-detail" \|\| id === "screen-new" \|\| id === "screen-settings"/.test(
      js.replace(/\s+/g, " "),
    )
  ) {
    fails.push("app.js 的 keepList 里应同时包含 screen-detail / screen-new / screen-settings");
  }
}

// ---------- ④ 筛选面板：折叠状态与"避让用户输入" ----------
// 真机才暴露、而且不报错的一条（手机版「编号范围填了没反应」的真凶）：
// 「打开筛选」会紧接着 requestImgStats()，等 imageStatsLoaded 回来时如果**整块**重画 filterBody，
// 用户正在打的那半截字连同焦点一起没了 —— 电脑上几乎遇不到，因为桌面版那个面板不是这么重画的。
// 2026-10-11 改版后这条闸门管四件事：
//   ① 编号范围**不许**再在筛选面板里单独有一组（已并进顶部搜索行）—— 同一个条件两个入口，
//      两边还得各记一份 state，而且那组还挂着三行说明文字。又冒出来就是有人把第二套加回来了。
//   ② 编号表达式只能有一个出处：codeExpr() 里"scope 是编号才用 state.q"。
//   ③ 折叠状态必须在 state.openGroups（不在 DOM 上），否则异步回包一重画，展开的那组就折回去了。
//   ④ 编号模式不许边打边筛（区间语法有中间态 A → A1 → A1~，一路 renderList() 会闪）。
const fnBody = (name) => {
  const i = js.indexOf(`function ${name}(`);
  if (i < 0) {
    return null;
  }
  const open = js.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < js.length; j++) {
    if (js[j] === "{") depth++;
    else if (js[j] === "}") {
      depth--;
      if (depth === 0) return js.slice(i, j + 1);
    }
  }
  return null;
};

const renderFilterFn = fnBody("renderFilter");
const refreshGroupsFn = fnBody("refreshFilterGroups");
if (!renderFilterFn || !refreshGroupsFn) {
  fails.push(
    "筛选面板的重画函数改名/挪走了（renderFilter / refreshFilterGroups）："
      + "这条闸门就失效了，请同步更新 check-mobile-wiring.cjs",
  );
} else {
  // ① 编号范围那两个 id 不许再出现
  for (const legacy of ['id="codeQ"', "renderFilterCodeInput"]) {
    if (js.includes(legacy) || html.includes(legacy)) {
      fails.push(
        `${legacy} 又冒出来了：编号范围已并进顶部搜索行（scope 选「编号」那个框就吃 A1~A33 语法），`
          + "筛选面板里不该再有第二套入口 —— 见 docs/手机版-筛选改版 那段说明",
      );
    }
  }
  // ② 编号表达式只有一个出处
  const codeExprFn = fnBody("codeExpr");
  if (!codeExprFn) {
    fails.push("找不到 codeExpr()：编号表达式现在只从搜索行来，这个函数是它的唯一出处");
  } else if (!/state\.scope === "code"/.test(codeExprFn) || !/state\.q/.test(codeExprFn)) {
    fails.push("codeExpr() 里应写成「scope 是编号时才用 state.q」—— 换别的来源就等于又开了第二套编号筛选");
  }
  // ③ 折叠状态在 state 里，不在 DOM 上
  if (!/openGroups/.test(js)) {
    fails.push("找不到 state.openGroups：筛选面板的折叠状态必须存在 state 里，否则异步重画会把展开的组折回去");
  }
  if (/classList[\s\S]{0,80}folded[\s\S]{0,200}(renderFilter|refreshFilterGroups)/.test(js)) {
    fails.push("折叠状态看着是从 DOM 上反读的：应该只认 state.openGroups");
  }
  // ④ 编号模式不许边打边筛
  const qIdx = js.indexOf('$("q").oninput = function ()');
  if (qIdx < 0) {
    fails.push("找不到 $(\"q\").oninput（写法变了？这条闸门就失效了）");
  } else {
    const block = js.slice(qIdx, qIdx + 400);
    if (!/state\.scope === "code"/.test(block) || !/return;/.test(block)) {
      fails.push(
        '编号模式下 $("q").oninput 必须早退（只更新 #qHint，不当场 renderList）：'
          + "区间语法有中间态 A → A1 → A1~，边打边筛列表会一路闪",
      );
    }
  }
  // ⑤ 图片统计那条异步路必须避让
  // 取 imageStatsLoaded 之后的一段窗口即可（不写贪心正则：缩进/分支写法一改就假红）
  const statsIdx = js.indexOf('"imageStatsLoaded"');
  if (statsIdx < 0) {
    fails.push("找不到 imageStatsLoaded 的处理分支（写法变了？这条闸门就失效了）");
  } else {
    const statsBlock = js.slice(statsIdx, statsIdx + 600);
    if (/renderFilter\(\)/.test(statsBlock)) {
      fails.push(
        "imageStatsLoaded 那条异步回包里调了 renderFilter()：手机上回包常落在用户打字中间，"
          + "会把区间框整块重建、字和焦点一起丢。应改调 refreshFilterGroups()",
      );
    } else if (!/refreshFilterGroups\(\)/.test(statsBlock)) {
      fails.push("imageStatsLoaded 里既没调 refreshFilterGroups() 也没调 renderFilter()：图片数字不会更新了");
    }
    if (!/filterBodyHasFocus\(\)/.test(statsBlock)) {
      fails.push(
        "imageStatsLoaded 里应先用 filterBodyHasFocus() 避让：数字区间框（进价/售价/库存）"
          + "同样会被重画，用户正打字时不该被冲掉",
      );
    }
  }
}

// ---------- ④b 套装详情页：页签不许被藏起来，那两块的显隐归 CSS 管 ----------
// 2026-10-11 改定：套装**也走三个页签**（原先那版是 `#screen-detail.set #dTabs{display:none}`，
// 一屏到底）。改的原因很实在 ——「售价」和「比合计（= 售价 − 合计售价）」是同一个决定的两个面，
// 必须挨着看。这条闸门钉住改定后的两条约束：
//   ① style.css 里不许再出现"把套装的页签藏起来"的规则。真藏了，合计区和子商品清单会**同时**
//      铺在一屏上（一块在价格卡里、一块在基本信息卡里），界面直接乱掉。
//   ② #dSetSum / #dSetListCard 的显隐必须由 CSS 按 .set 类控制，**JS 不许直接改它们的 display**：
//      否则普通商品切到「价格库存」页时会露出一块空的浅底合计框。
{
  if (/#screen-detail\.set\s+#dTabs\s*\{[^}]*display:\s*none/.test(css)) {
    fails.push(
      "style.css 里又有「套装把 #dTabs 藏起来」的规则了：套装现在也走三个页签，"
        + "藏掉之后合计区和子商品清单会同时铺在一屏上（2026-10-11 已改定）",
    );
  }
  for (const id of ["dSetSum", "dSetListCard"]) {
    if (!new RegExp(`#screen-detail\\.set\\s+#${id}\\s*\\{[^}]*display:`).test(css)) {
      fails.push(
        `style.css 里缺少 "#screen-detail.set #${id}" 的 display 规则：套装那一块的显隐没了着落`,
      );
    }
    if (new RegExp(`\\$\\("${id}"\\)\\.style\\.display`).test(js)) {
      fails.push(
        `app.js 里直接改了 #${id} 的 style.display：应该交给 CSS（#screen-detail.set ...），`
          + "否则切到普通商品时要靠人记得复位",
      );
    }
  }
  // 合计区必须落在「价格库存」那张卡里（不能又挂到表单最后）——判据：合计区在 dPanePrice 之后、
  // dPaneRemark 之前。位置错了这条改动的意义就没了（售价和比合计又分家了）。
  const sumAt = html.indexOf('id="dSetSum"');
  const priceAt = html.indexOf('id="dPanePrice"');
  const remarkAt = html.indexOf('id="dPaneRemark"');
  if (!(priceAt >= 0 && remarkAt >= 0 && sumAt > priceAt && sumAt < remarkAt)) {
    fails.push(
      "index.html 里 #dSetSum 没落在「价格库存」页里（应在 #dPanePrice 之后、#dPaneRemark 之前）："
        + "合计区必须挨着售价，否则「比合计 = 售价 − 合计售价」这两个数又分家了",
    );
  }
  if (!(sumAt > 0 && html.indexOf('id="fSale"') > priceAt && html.indexOf('id="fSale"') < sumAt)) {
    fails.push("index.html 里 #dSetSum 应在售价输入框（#fSale）**之后**：合计区要在售价正下方");
  }
  // 清单必须落在「基本信息」页里（dPaneBase 之后、dPanePrice 之前）
  const listAt = html.indexOf('id="dSetListCard"');
  if (!(listAt > html.indexOf('id="dPaneBase"') && listAt < priceAt)) {
    fails.push("index.html 里 #dSetListCard 没落在「基本信息」页里（应在 #dPaneBase 之后、#dPanePrice 之前）");
  }
}

// ---------- ⑤ 手机版的「不许有空格」清单必须与电脑版一致 ----------
// 为什么值得一道闸门：粘贴导入是按**空白**分列的（rowParse.ts 的 splitCells 用 [,;，；\s]+），
// 「每日销售」批量粘贴更是拿空格当分隔符。所以名称/品类/系列一旦有空格，导入时那一行会从空格处
// 劈开、后面所有列整体错位。电脑版靠 FIELD_SPECS 的 noSpace 拦，手机版是另一份代码 —— 两边漂了
// 就会出现「电脑上存不进去、手机上存进去了」，等哪天导入才发现数据是坏的。
{
  const coreFile = path.join(root, "src", "tools", "shopTool", "client-core.js");
  const core = fs.readFileSync(coreFile, "utf8");
  const deskNoSpace = new Set(
    [...core.matchAll(/\{\s*key:\s*"(\w+)"[^}]*noSpace:\s*true[^}]*\}/g)].map((m) => m[1]),
  );
  const mobMatch = /var NO_SPACE_TEXT_FIELDS = \{([^}]*)\}/.exec(js);
  if (deskNoSpace.size === 0) {
    fails.push("client-core.js 里没找到任何 noSpace:true 字段（写法变了？这条闸门就失效了）");
  } else if (!mobMatch) {
    fails.push(
      "app.js 里找不到 NO_SPACE_TEXT_FIELDS：手机版就没人拦空格了，导入会静默错位",
    );
  } else {
    const mobNoSpace = new Set(
      [...mobMatch[1].matchAll(/(\w+)\s*:\s*1/g)].map((m) => m[1]),
    );
    for (const k of deskNoSpace) {
      if (!mobNoSpace.has(k)) {
        fails.push(`电脑版不许有空格、「${k}」，但手机版 NO_SPACE_TEXT_FIELDS 里没有它`);
      }
    }
    for (const k of mobNoSpace) {
      if (!deskNoSpace.has(k)) {
        fails.push(`手机版不许有空格、「${k}」，但电脑版 FIELD_SPECS 没标 noSpace（两边不一致）`);
      }
    }
    // 两条提交路径都必须真的用它（只声明不检查 = 白写）
    const uses = (js.match(/NO_SPACE_TEXT_FIELDS\[/g) || []).length;
    if (uses < 2) {
      fails.push(
        `NO_SPACE_TEXT_FIELDS 只被用了 ${uses} 处（应有 ≥2：格子内编辑 commitEdit + 详情页 commitDetailField）`,
      );
    }
    // 三层拦截，缺一层就有漏网的输入框。
    // ⚠️ 这里刻意**不**用结构性正则去数 `^`/$ 之类的写法：那种断言分不清"真删了这一层"
    //    和"写法换了个等价形式"（实测把 `if (!/\s/.test(v)) return;` 改成 `if (true) return;`
    //    语义完全一样，正则却照样命中 → 假绿）。所以这两层用**行为**断言。
    if (!/e\.key === " "[\s\S]{0,160}?preventDefault\(\)/.test(js)) {
      fails.push("wireNoSpaceInput 里没有 keydown 拦空格键：用户直接在输入框里就能打出空格");
    }
    // ② + ③ 行为断言：把 normalizeNoSpaceText 与 wireNoSpaceInput 的 input 回调原样抽出来跑
    const nsFn = fnBody("normalizeNoSpaceText");
    const wireFn = fnBody("wireNoSpaceInput");
    if (!nsFn) {
      fails.push("找不到 normalizeNoSpaceText：提交那一刻的最后一道清洗没了");
    } else {
      try {
        // 造一个够用的宿主环境（这两个函数都只用到 $ / pushLog / toast 和 NO_SPACE_TEXT_FIELDS）
        const label = { name: "名称", category: "品类", series: "系列", purchase_link: "采购链接" };
        const ns = new Function(
          `const NO_SPACE_TEXT_FIELDS = { name: 1, category: 1, series: 1, purchase_link: 1 };
           const FIELD_LABEL = ${JSON.stringify(label)};
           ${nsFn}
           return normalizeNoSpaceText;`,
        )();
        const stripCases = [
          ["铜合金锆石手链", "铜合金锆石手链", false],
          ["铜合金 锆石手链", "铜合金锆石手链", true],
          // 首尾也算"动过值"：值确实变了，就该提示一声（changed=false 会让用户白挨一次静默修改）
          ["  手链  ", "手链", true],
          ["四叶花\t手链", "四叶花手链", true],
          ["四叶花\u3000手链", "四叶花手链", true],
        ];
        for (const [input, expect, expectChanged] of stripCases) {
          const r = ns("name", input);
          if (r.value !== expect || r.changed !== expectChanged || !r.ok) {
            fails.push(
              `normalizeNoSpaceText("name", ${JSON.stringify(input)}) 结果不对：` +
                `得到 value=${JSON.stringify(r.value)} changed=${r.changed}，` +
                `应为 value=${JSON.stringify(expect)} changed=${expectChanged}`,
            );
          }
        }
        // 备注必须原样放行（空格有意义）
        const rk = ns("remark", "客户说要改链条 18cm");
        if (!rk.ok || rk.changed || rk.value !== "客户说要改链条 18cm") {
          fails.push(`normalizeNoSpaceText 把备注也洗了：${JSON.stringify(rk)}（备注要能带空格）`);
        }
      } catch (e) {
        fails.push(`normalizeNoSpaceText 行为断言跑不起来（写法变了？）：${e && e.message}`);
      }
    }
    // ② 去掉空格那一步：**必须挂在 blur 上**。
    //    ⚠️ 这是踩出来的教训，闸门要钉住它：第一版挂在 input 上、一发现空格就写回 el.value，
    //    结果把中文输入法的组合状态打散了（拼音是 composition 中间态，程序写一次值就等于
    //    宣告组合结束，输入法把拼音直接上屏、后面的键重新开始组合）—— 用户看到"打一句话多出好多字"。
    //    所以：blur 里必须真的洗掉空格；input 里**绝对不许**写 el.value。
    if (!wireFn) {
      fails.push("找不到 wireNoSpaceInput：输入框那两层拦截没了");
    } else {
      const grabHandler = (evt) => {
        const at = wireFn.indexOf(`addEventListener("${evt}"`);
        if (at < 0) {
          return null;
        }
        const open = wireFn.indexOf("{", wireFn.indexOf("function", at));
        let depth = 0;
        for (let i = open; i < wireFn.length; i++) {
          if (wireFn[i] === "{") depth++;
          else if (wireFn[i] === "}") {
            depth--;
            if (depth === 0) return wireFn.slice(open + 1, i);
          }
        }
        return null;
      };
      const runHandler = (evt, value) => {
        const body = grabHandler(evt);
        if (body === null) {
          return { missing: true };
        }
        const fake = { value: value, addEventListener() {} };
        const logs = [];
        new Function("el", "label", "pushLog", "toast", "FIELD_LABEL", `${body}`)(
          fake, "名称", (t) => logs.push(t), () => {}, { name: "名称" },
        );
        return { value: fake.value, logs: logs };
      };

      // blur 上必须真的洗
      const blurCases = [
        ["铜合金锆石手链", "铜合金锆石手链", 0],
        ["铜合金 锆石手链", "铜合金锆石手链", 1],
        ["A B C", "ABC", 2],
        ["四叶花\u3000手链", "四叶花手链", 1],
      ];
      for (const [input, expect, expectRemoved] of blurCases) {
        const r = runHandler("blur", input);
        if (r.missing) {
          fails.push("wireNoSpaceInput 里没有 blur 监听：粘贴/输入法塞进来的空格没人洗");
          break;
        }
        if (r.value !== expect) {
          fails.push(
            `wireNoSpaceInput 的 blur 回调没洗掉空格：输入 ${JSON.stringify(input)} → ` +
              `留下 ${JSON.stringify(r.value)}（应为 ${JSON.stringify(expect)}）`,
          );
        } else if (expectRemoved > 0 && r.logs.length === 0) {
          fails.push(
            `wireNoSpaceInput 洗掉空格时没吭声（${JSON.stringify(input)}）：` +
              `默默改用户输入会让他以为输入法坏了，必须提示一句`,
          );
        }
      }

      // input 上绝对不许写 el.value（会把中文输入法打散）
      const inputBody = grabHandler("input");
      if (inputBody !== null && /el\.value\s*=/.test(inputBody)) {
        fails.push(
          "wireNoSpaceInput 在 input 监听里写了 el.value —— 会打断中文输入法的组合状态，" +
            "表现是「打字时多出好多字」。空格要等 blur 再洗。",
        );
      }
      // 而且反过来：blur 之外也别再挂 input 去洗（上面那条只在写了 value 时触发，这里补一句明确的）
      if (inputBody !== null && /replace\(\/\\s\+\/g/.test(inputBody)) {
        fails.push("wireNoSpaceInput 在 input 监听里洗空格：实时改值会打断输入法，请挪到 blur");
      }
      // 输入法组合期不许拦按键（拼音选词就是按空格/数字确认的）
      if (!/e\.isComposing|keyCode === 229/.test(wireFn)) {
        fails.push(
          "wireNoSpaceInput 的 keydown 没有放过输入法组合期（e.isComposing / keyCode 229）：" +
            "拼音选词按空格会被吃掉，等于打不了中文",
        );
      }
    }
    // 备注必须不受限（它是自由文本，句子里的空格有意义）
    if (/NO_SPACE_TEXT_FIELDS = \{[^}]*remark/.test(js)) {
      fails.push("NO_SPACE_TEXT_FIELDS 里不该有 remark：备注是要能带空格的自由文本");
    }
  }
}

// ---------- ⑥ 三层外壳：顶上「找东西」/ 内容区小 tab / 底部 tab 栏 ----------
// 2026-10-12 重排了手机版外壳（见 docs/手机版-界面重构示意.html）。这一层全是
// **不报错但界面坏** 的东西，所以逐条钉住：
//   ① 底部 tab 栏是 fixed 铺满整宽的，四个 .screen 都得给它留高度 —— 高度只有一个出处
//      （:root 的 --tabbar），任一边改了名/写死了数字，表现就是"分页条被 tab 栏压住半行"。
//   ② 日志从"底部细条弹的浮层"并进设置页当第三个页签：showSettingsTab 必须有 log 这一页，
//      而且切进去要补画一次（日志平时攒着不画，不补画看着就是「日志不更新」）。
//   ③ 旧壳的东西不许回来：#status / #btnLog / #logPanel / #btnStale / #btnSetBack / #btnSettings。
//      一旦有人"顺手加回来"，就是两个入口干同一件事、或者点了没反应。
{
  if (!/:root\s*\{[^}]*--tabbar\s*:\s*\d+px/.test(css)) {
    fails.push("style.css 的 :root 里找不到 --tabbar：底部 tab 栏的高度没有唯一出处了");
  }
  if (!/\.screen\s*\{[^}]*padding-bottom:\s*calc\(var\(--tabbar\)/.test(css)) {
    fails.push(
      ".screen 的 padding-bottom 应写成 calc(var(--tabbar) + env(safe-area-inset-bottom))："
        + "否则屏幕内容会被底部 tab 栏压住（分页条少半行就是这么来的）",
    );
  }
  if (!/\.tabbar\s*\{[^}]*height:\s*calc\(var\(--tabbar\)/.test(css)) {
    fails.push(
      ".tabbar 的高度必须写成 calc(var(--tabbar) + env(safe-area-inset-bottom))，与 .screen 那份用同一个变量",
    );
  }
  if (!html.includes('id="tabbar"')) {
    fails.push('index.html 里没有 id="tabbar"：底部 tab 栏（商品 / 设置）不在');
  }
  if (!html.includes('id="staleDot"')) {
    fails.push('index.html 里没有 id="staleDot"：「有改动」那个小红点没地方长');
  }
  if (!/isLogTabVisible/.test(js)) {
    fails.push(
      "app.js 里找不到 isLogTabVisible()：pushLog 会不看场合地重画日志"
        + "（日志页签没打开时纯属白干）",
    );
  }
  // 「清空」按钮要两头都钉住：HTML 里挂着一个按钮、app.js 里没接 onclick = 点了没反应。
  // 这类「死按钮」最不容易被发现 —— 页面看上去完全正常，只是那一下永远没反应。
  // （上面那条 id 存在性检查只管 app.js → index.html 一个方向，管不到这里。）
  if (!html.includes('id="btnClearLog"')) {
    fails.push('index.html 里没有 id="btnClearLog"：「设置 → 日志」那个清空按钮不在');
  }
  if (!/\$\("btnClearLog"\)\s*\.\s*onclick/.test(js)) {
    fails.push("app.js 里没给 #btnClearLog 接 onclick：日志那个「清空」按钮点了没反应");
  }
  const settingsTabFn = fnBody("showSettingsTab");
  if (!settingsTabFn) {
    fails.push("找不到 showSettingsTab()：这条闸门就失效了，请同步更新 check-mobile-wiring.cjs");
  } else {
    if (!/log:\s*\$\("tabLog"\)/.test(settingsTabFn)) {
      fails.push('showSettingsTab 里少了 log: $("tabLog")：设置页第三个页签（日志）没接上');
    }
    if (!/name === "log"[\s\S]{0,80}renderLogs\(\)/.test(settingsTabFn)) {
      fails.push(
        "showSettingsTab 里切到 log 页签时没有 renderLogs()：日志平时攒着不画，"
          + "切进去不补画一次，看着就是「日志不更新」",
      );
    }
  }
  for (const legacy of ["status", "btnLog", "logPanel", "btnStale", "btnSetBack", "btnSettings"]) {
    if (html.includes(`id="${legacy}"`) || js.includes(`$("${legacy}")`) || css.includes(`#${legacy}`)) {
      fails.push(
        `#${legacy} 又出现了：2026-10-12 已经把它并进新外壳（日志→设置页签、有改动→设置格小红点、`
          + "设置→底部 tab 栏）。加回来就是两个入口干同一件事、或者点了没反应",
      );
    }
  }
}

// ---------- ⑦ 翻页条：六个控件收成三个（2026-10-12 第 2 批） ----------
// 收成 `‹ 上一页 · [1/7 页 ▾] · 下一页 ›`，中间那颗就是跳页下拉（#pageJump）做成胶囊。
// 这里钉住四件"不报错但界面坏"的事：
//   ① 旧的三件不许回来（#pageFirst / #pageLast / #pageInfo）—— 回来就是第四五个控件；
//   ② `.pager` 是 display:flex，浏览器给 [hidden] 的那条 display:none **盖不住它** →
//      少了 `.pager[hidden]{display:none}`，≤1 页时会顶出一条空的分页条（手机上白占 50px）；
//   ③ 中间那颗的选项文字必须是「N/M 页」—— 胶囊收起时显示的就是选中项那行字，
//      写成「第 N 页」就跟这张图不一样了（也看不出"共几页"）；
//   ④ `appearance:none` 不能丢：丢了浏览器按系统样式画那个下拉，胶囊外观整个出不来。
{
  for (const legacy of ["pageFirst", "pageLast", "pageInfo"]) {
    if (html.includes(`id="${legacy}"`) || js.includes(`$("${legacy}")`)) {
      fails.push(
        `#${legacy} 又出现了：翻页条已收成三控件（‹ 上一页 · 1/7 页 · 下一页 ›），`
          + "加回来就是第四五个控件（`«`/`»`/条数都撤了）",
      );
    }
  }
  if (!html.includes('id="pager"')) {
    fails.push('index.html 里没有 id="pager"：renderPager 就没法把整条收起来（≤1 页时）');
  }
  if (!/\.pager\[hidden\]\s*\{[^}]*display:\s*none/.test(css)) {
    fails.push(
      "style.css 里缺 .pager[hidden]{display:none}：.pager 自己是 display:flex，"
        + "浏览器给 [hidden] 的那条盖不住它 —— ≤1 页时会出现一整条空的分页条",
    );
  }
  if (!/\.pager select\.pj\s*\{[^}]*appearance:\s*none/.test(css)) {
    fails.push(
      ".pager select.pj 里没有 appearance:none：浏览器会按系统样式画那个下拉，胶囊外观出不来",
    );
  }
  if (!html.includes('class="pj"')) {
    fails.push('index.html 的跳页下拉少了 class="pj"：中间那颗胶囊的样式没了着落');
  }
  const rpFn = fnBody("renderPager");
  if (!rpFn) {
    fails.push("找不到 renderPager()：这条闸门就失效了，请同步更新 check-mobile-wiring.cjs");
  } else {
    // ⚠️ 断言必须精确到「设成 one」：只写 /\.hidden\s*=/ 的话，改成 `pager.hidden = false`
    //    照样绿（变异自检真抓到过这条漏网）。
    if (!/\$\("pager"\)/.test(rpFn) || !/\.hidden\s*=\s*one\b/.test(rpFn)) {
      fails.push(
        "renderPager 里应写成 `pager.hidden = one;`（one = 页数 ≤1）："
          + "否则 ≤1 页时那条分页条收不起来",
      );
    }
    // ⚠️ 这条**必须锚在 `opts +=` 那一行**：文件下面 jump.title 里也有一模一样的
    //    `"/" + pages + " 页`（"共 N 条 · 第 P/Q 页"），只搜全文会被它救活（变异抓过一次漏网）。
    if (!/opts\s*\+=[^\n]*?\/"\s*\+\s*pages\s*\+\s*"\s*页/.test(rpFn)) {
      fails.push(
        "renderPager 里跳页下拉（opts += …）的选项文字不是「N/M 页」："
          + "中间那颗胶囊收起时显示的就是这行字",
      );
    }
  }
}

// ---------- ⑧ 搜索行右侧：状态 / 品类 / 等级统一下拉（2026-10-12） ----------
// 原先品类/等级在搜索行里是"一排圆片"，而**桌面端当时就做成了下拉**
// （client-product.js 的 KW_SELECT_SCOPES = 状态/品类/等级，那边注释写着"商家明确说过不喜欢圆圈圈"）。
// 手机版漏了两列，2026-10-12 补齐。这里钉住四件事：
//   ① 那排圆片的痕迹（#scopeChips / .scopechips / SCOPE_CHIP_COLS / renderScopeChips）
//      不许回来 —— 圆圈只留在筛选面板里（那边要**多选**，下拉给不了）；
//   ② 三列共用**一个** #scopeValue 下拉，不许再拆出 #scopeStatus 那样"一列一个控件"；
//   ③ 圆片换下拉最容易漏的一步：**搜索框要跟着藏起来**（这三列的条件在下拉里，不在搜索框里）。
//      漏了这一步，切到"品类"时搜索框还露着、上一段文字还接着筛（看着像 bug）；
//   ④ 选完要真的写进 state.filters.enum[列]（跟筛选面板同一份），且值要**读得回来** ——
//      否则就是下拉显示一套、实际筛另一套（界面说谎）。
{
  if (html.includes('id="scopeChips"') || js.includes('$("scopeChips")')) {
    fails.push(
      '#scopeChips 又出现了：搜索行的品类/等级已统一成下拉（商家不要圆圈圈），'
        + "圆圈只留在筛选面板里（那边要多选）",
    );
  }
  // ⚠️ 先剥掉 CSS 注释再查：style.css 里那段"圆片撤了"的说明**本身就写着 .scopechips**，
  //    直接 css.includes 会被自己的注释救活（"注释骗过断言"这个坑抽屉断点那段真栽过）。
  const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/\.scopechips\b/.test(cssNoComment)) {
    fails.push(
      "style.css 里还有 .scopechips 规则：搜索行那排圆片已改成下拉（圆圈只留在筛选面板里）",
    );
  }
  for (const gone of ["SCOPE_CHIP_COLS", "renderScopeChips", "renderScopeStatus"]) {
    if (js.includes(gone)) {
      fails.push(`${gone} 又出现了：搜索行那排圆片（以及"状态单开一个下拉"）的残骸，已并进 renderScopeValue`);
    }
  }
  if (!html.includes('id="scopeValue"')) {
    fails.push('index.html 里没有 id="scopeValue"：状态/品类/等级共用的那个下拉没地方长');
  }
  if (html.includes('id="scopeStatus"')) {
    fails.push(
      'index.html 里还有 id="scopeStatus"：状态下拉已并进 #scopeValue（三列共用一个），'
        + "留着就是两套控件管同一个条件",
    );
  }
  const asFn = fnBody("applyScope");
  if (!asFn) {
    fails.push("找不到 applyScope()：这条闸门就失效了，请同步更新 check-mobile-wiring.cjs");
  } else {
    if (!/SCOPE_SELECT_COLS\[scope\]/.test(asFn)) {
      fails.push("applyScope 里没按 SCOPE_SELECT_COLS 判断这一列要不要换成下拉");
    }
    // ⚠️ 必须精确到 `q.hidden = isSelectCol`：只写 /q\.hidden\s*=/ 的话，
    //    改成 `q.hidden = false`（搜索框永远露着）照样绿。
    if (!/q\.hidden\s*=\s*isSelectCol\b/.test(asFn)) {
      fails.push(
        "applyScope 里搜索框的显隐要走 isSelectCol（`q.hidden = isSelectCol`）："
          + "漏了这一步，切到品类/等级时搜索框还露着、上一段文字还接着筛",
      );
    }
    if (!/renderScopeValue\(scope\)/.test(asFn)) {
      fails.push("applyScope 里切到那几列时要调 renderScopeValue(scope) 把选项摆上");
    }
  }
  const rvFn = fnBody("renderScopeValue");
  if (!rvFn) {
    fails.push("找不到 renderScopeValue()：状态/品类/等级那个下拉的选项就没出处了");
  } else {
    if (!/state\.filters\.enum\[scope\]/.test(rvFn)) {
      fails.push(
        "renderScopeValue 里要从 state.filters.enum[scope] 把当前值读回来："
          + "不读就是下拉显示一套、实际筛另一套（界面说谎）",
      );
    }
  }
  if (!/\$\("scopeValue"\)\s*\.\s*onchange/.test(js)) {
    fails.push('app.js 里没给 #scopeValue 接 onchange：那个下拉选了没反应');
  } else if (!/state\.filters\.enum\[state\.scope\]/.test(js)) {
    fails.push(
      "scopeValue 的 onchange 要写进 state.filters.enum[当前列]（跟筛选面板同一份），否则两边不联动",
    );
  }
}

// ---------- ⑨ 详情页那个 ‹ ：永远是「回商品列表」，没有「返回上一步」（2026-10-12） ----------
// 原先从套装点进子商品，那个 ‹ 会回**那个套装**（一个来路栈），按钮文案也跟着改成 ‹ T001。
// 问题是套装和子商品能互相点（A→B→A→B），堆几次之后用户根本不知道这一下会退到哪儿。
// **电脑端一直没有这个「返回上一步」**（docs/套装-使用说明.md 里写着"没有返回上一步按钮，别找"），
// 手机版这次跟它对齐。这里钉三件事：
//   ① 来路栈那套名字不许回来（栈变量、对它的操作、改文案的 updateBackLabel）；
//   ② 返回键文案固定「商品」，不再随来路变；
//   ③ 回套装的路只剩子商品页顶部那条「属于 T001」—— 它必须还在（删了就是真的回不去了）。
{
  // ⚠️ 断言一律写"代码形状"，不写裸的标识符：上面那段说明里就写着 `detailBack`，
  //    用 js.includes("detailBack") 会被自己的注释救活（.scopechips 那次就是这么假绿的）。
  if (/\bvar\s+detailBack\b/.test(js) || /detailBack\s*\.\s*(length|push|pop)\b/.test(js)) {
    fails.push(
      "app.js 里又出现了来路栈 detailBack：详情页的 ‹ 已定成「永远回商品列表」，"
        + "再压栈就等于这一下有两个去向，用户猜不出来",
    );
  }
  if (/\bupdateBackLabel\b/.test(js)) {
    fails.push(
      "app.js 里又出现了 updateBackLabel：返回键文案已固定「商品」，不再随来路变（见上一条）",
    );
  }
  if (!/id="backText"\s*>\s*商品\s*</.test(html)) {
    fails.push('index.html 里 #backText 的文案应固定写「商品」（它不再随来路变了）');
  }
  if (!/\$\("btnBack"\)\s*\.\s*onclick/.test(js)) {
    fails.push('app.js 里没给 #btnBack 接 onclick：详情页那个 ‹ 点了没反应');
  }
  if (!html.includes('id="dSetOf"')) {
    fails.push(
      'index.html 里没有 id="dSetOf"：从子商品回套装**只剩这一条路**了，删掉就真的回不去',
    );
  }
}

// ---------- ⑩ 列表行：图片列（名称之后）+ 状态胶囊（2026-10-12） ----------
// 商家要的两件事：① 列表加「图片」列；② 状态格从"一行普通黑字"改成一眼看出能点的胶囊。
// 这里钉四件最容易坏的事：
//   ① 图片列的 src 走 imgUrl、没图靠 onerror 兜底 —— **不许**改成"先查 imgStats 判断有没有图"：
//      imgStats 只在"要按图片筛"时才请求，拿它当条件会让整个列表先显示成"全都没图"；
//   ② 图片列在**「名称」之后、「进价」之前**（商家 2026-10-12 二次定：先看编号和名字，
//      再看图长什么样；第一版放最左，把"编号—名称"这对主信息拆开了）；
//   ③ 状态格的 data-ed **必须留在 <td> 上**：点一下切换靠 closest("td[data-ed]") 找，
//      挪到内层 span 就整个失效（点了没反应）；
//   ④ CSS 三件套 .tblpic / .tblpic-no / .stpill 都得在，表格 min-width 也要跟着八列加宽，
//      缩略图还要**留一点缝 + 圆角**（商家："太贴合了，之前的弧形也挺好看"）。
{
  // ⚠️ CSS 断言先剥注释：上面这段说明里就写着 .tblpic 这些名字，直接用 includes 会被自己的注释救活
  const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rowAt = js.indexOf("function rowHtml(p)");
  const rowRaw = rowAt < 0 ? "" : js.slice(rowAt, js.indexOf("function findProduct(id)"));
  // ⚠️ 先剥行注释再断言：rowHtml 上面那段注释里就写着 .tblpic / .tblpic-no / .stpill 这些名字，
  //    不剥的话「图片列没了」这种断言会被自己的注释救活 —— 这轮的 w-no-nopic 真漏网过一次。
  const row = rowRaw.replace(/\/\/[^\n]*/g, "");
  if (!/class="tblpic"/.test(row) || !/imgUrl\(p\.code, "", "thumb"\)/.test(row)) {
    fails.push('rowHtml 里没有图片列（或没走 imgUrl(p.code, "", "thumb")）：列表那张缩略图取不到');
  }
  if (!/onerror/.test(row) || !/tblpic-no/.test(row)) {
    fails.push("图片列少了 onerror 兜底：没图的商品会显示成破图，而不是「无图」占位");
  }
  if (/imgStats/.test(row)) {
    fails.push(
      "图片列不该拿 imgStats 判断「有没有图」：它只在要按图片筛时才请求，一进列表就是空的" +
        " → 整片显示成「无图」（实际取图靠 src + onerror 就够了）",
    );
  }
  const iPic = row.indexOf('<td class="pic"');
  const iNm = row.indexOf('<td class="nm ed');
  const iCost = row.indexOf('data-ed="cost_price"');
  if (iPic < 0 || iNm < 0 || iCost < 0 || !(iNm < iPic && iPic < iCost)) {
    fails.push(
      "图片列没排在「名称」之后、「进价」之前（商家 2026-10-12 二次定的位置：" +
        "先看编号和名字，再看图）",
    );
  }
  if (!/'" data-ed="status" title="'/.test(row)) {
    fails.push(
      '状态格的 data-ed="status" 不在 <td> 上：点一下切换靠 closest("td[data-ed]") 找它，' +
        "挪到内层 span 就点了没反应",
    );
  }
  if (!/class="stpill/.test(row)) {
    fails.push("状态格没套胶囊（.stpill）：又退回成一行跟旁边数字长得一样的黑字了");
  }
  if (!/<th>名称<\/th><th class="pic">图片<\/th>/.test(js)) {
    fails.push("表头里图片列不在「名称」后面（或整个没了）");
  }
  for (const sel of [".tblpic", ".tblpic-no", ".stpill", ".stpill.off"]) {
    if (!new RegExp(sel.replace(/\./g, "\\.") + "\\s*\\{").test(cssBare)) {
      fails.push(`style.css 里找不到规则 ${sel} —— 少了它图片会撑破格子 / 胶囊退化成方框`);
    }
  }
  if (!/min-width:\s*calc\(630px \* var\(--zoom\)\)/.test(cssBare)) {
    fails.push("表格 min-width 没跟着加宽到 630px：八列 + 75px 宽的图片列，窄了会把别的列挤瘦");
  }
  // ⚠️ 下面是图片列"尺寸账"的守门（2026-10-12 一天内返工五次的全部教训）：
  //    账目（C 档，商家选的）：数据行上下 padding 27×2 + 字高 19.5 = 行高 **73.5**
  //      ≥ td.pic 的 3+3 + 图高 **67** = 73 → 图片格不参与决定行高。
  //    这一组数（27 / 3 / 67 / 75）是一套，改任一个都要重算：
  //    死路①：图留在普通流里 + td 给 11px padding → 32+22 = 54，整表虚胖（"空了好多"）；
  //    死路②：图改 absolute + inset 3/4 + width:100% → 替换元素**过度约束**，right 被丢掉 → 图捅出格子
  //           （"好像超出单元格了"），而且这种写法依赖 td 建包含块 → "电脑没有、手机有点偏"；
  //    死路③：行的 padding 改小（11）→ 行高只剩 41.5 < 73，图片格**反过来**把整表撑高。
  //    所以现在故意**不用绝对定位**，全部用写死的 px（跟着 --zoom），哪个引擎算出来都一样。
  if (/\.tblpic[^{]*\{[^}]*position:\s*absolute/.test(cssBare)) {
    fails.push(
      "列表缩略图又回到绝对定位了：配 td 的 padding 用会算错偏移（图捅出格子），" +
        "而且依赖 td 建包含块 —— 这个写法在手机浏览器上会「有点偏」。改成普通流 + 写死 px",
    );
  }
  if (!/\.tbl td\.pic\s*\{[^}]*padding:\s*calc\(3px \* var\(--zoom\)\)/.test(cssBare)) {
    fails.push(
      "图片格的 padding 不是上下 3px 了：它跟图高 67 一起凑成 73，必须 ≤ 数据行的 73.5，" +
        "超了就把整表行高撑高（商家反馈过「空了好多」）",
    );
  }
  if (!/\.tbl th,\s*\n\.tbl td\s*\{[^}]*padding:\s*calc\(27px \* var\(--zoom\)\)/.test(cssBare)) {
    fails.push(
      "数据行的上下 padding 不是 27px 了：行高 73.5 就是它撑出来的（27×2 + 字高 19.5），" +
        "改小到 11 的话行高只剩 41.5 < 73 —— 图片格会反过来把整表撑高",
    );
  }
  if (!/\.tblpic[^{]*\{[^}]*height:\s*calc\(67px \* var\(--zoom\)\)/.test(cssBare)) {
    fails.push(
      "列表缩略图的高度不是 67px（×zoom）了：3 + 67 + 3 = 73 这笔账要跟数据行的 73.5 一起看，" +
        "改大了会把整表行高撑高",
    );
  }
  if (!/\.tblpic[^{]*\{[^}]*width:\s*calc\(67px \* var\(--zoom\)\)/.test(cssBare)) {
    fails.push(
      "列表缩略图的宽度不是 67px（×zoom）了：缩略图是**正方形**，宽度必须跟高度一致" +
        "（图片列 75 = 67 + 左右各 4）",
    );
  }
  if (!/\.tblpic[^{]*\{[^}]*border-radius/.test(cssBare)) {
    fails.push("列表缩略图没有圆角了：商家明确说「之前的弧形挺好看」");
  }
}

// ---------- ⑪ 进货单：手机版第一个「独立功能文件」（2026-10-15） ----------
// 这块功能**刻意不写进 app.js**：骨架在 index.html 里那两屏、逻辑在 purchase.js、样式在
// purchase.css，两边靠 app.js 结尾那个 `window.Cherysis` 接缝通话（取元素/发消息/切屏/收消息）。
// 目的很实在：以后想整体摘掉它，删这三个文件里的几处就够，不用去 app.js 里翻。
// 这里钉住四类"页面看着完全正常、功能其实没接上"的事：
//   ① 底部那一格与两屏的骨架必须都在（少了 = 点了没反应 / 切过去一片空白）；
//   ② index.html 必须真的把 purchase.js / purchase.css 引进来（引不进 = 整个功能不存在）；
//   ③ #tabPurchase 得有人在 purchase.js 里接 onclick（HTML 挂了按钮没人接 = 死按钮）；
//   ④ 那两屏要 registerScreen 登记进 app.js 的屏幕表（不登记 → 切过去高亮还留在「商品」格，
//      看着像没切成功）；反过来，**app.js 里不许出现进货单的 id** —— 出现了就说明又堆回去了。
const pjsPath = path.join(mobileDir, "purchase.js");
const pjs = fs.existsSync(pjsPath) ? fs.readFileSync(pjsPath, "utf8") : "";
{
  if (!/window\.Cherysis\s*=/.test(js)) {
    fails.push(
      "app.js 里找不到 window.Cherysis 接入缝：独立功能文件（进货单等）拿不到它，会**静默**不跑",
    );
  }
  if (!html.includes('id="tabPurchase"')) {
    fails.push('index.html 里没有 id="tabPurchase"：底部「进货」那一格不在');
  }
  for (const id of ["screen-purchase", "screen-purchase-detail"]) {
    if (!html.includes(`id="${id}"`)) {
      fails.push(`index.html 里没有 id="${id}"：进货单那一屏的骨架不在（切过去会是空白）`);
    }
  }
  if (!html.includes('href="/purchase.css"')) {
    fails.push("index.html 没引入 purchase.css：进货单的样式不会生效（骨架会以无样式铺开）");
  }
  if (!html.includes('src="/purchase.js"')) {
    fails.push("index.html 没引入 purchase.js：进货单**整个不会跑**，而页面看上去完全正常");
  }
  if (!pjs) {
    fails.push(
      "找不到 purchase.js：进货单的逻辑文件不在（改名/挪走了？这条闸门就失效了，请同步更新本脚本）",
    );
  } else {
    if (!/\$\("tabPurchase"\)\s*\.\s*onclick/.test(pjs)) {
      fails.push("purchase.js 里没给 #tabPurchase 接 onclick：底部「进货」那一格点了没反应");
    }
    // 行内编辑走**整块委托**（行是重画的，逐行挂监听会被冲掉）。
    // 两条都要：input 管数量/备注，change 管编号归一与已办勾 —— 少一条那类改动就进不了草稿。
    for (const evt of ["input", "change"]) {
      if (!new RegExp(`addEventListener\\("${evt}"`).test(pjs)) {
        fails.push(
          `purchase.js 里没有 "${evt}" 委托：行里那一类改动不会进本地草稿（存下去还是旧的）`,
        );
      }
    }
    for (const id of ["screen-purchase", "screen-purchase-detail"]) {
      if (!new RegExp(`registerScreen\\("${id}"`).test(pjs)) {
        fails.push(
          `${id} 没在 purchase.js 里 registerScreen：切到它时底部 tab 的高亮会落在错误的格子上`,
        );
      }
    }
    for (const need of ["purchaseState", "purchaseSaved"]) {
      if (!new RegExp(`API\\.on\\("${need}"`).test(pjs)) {
        fails.push(`purchase.js 没订阅 "${need}" 回包：后端发了没人接，那一块永远不更新`);
      }
    }
  }
  // 反向：**app.js 里不许**出现进货单的 id（这个功能是独立文件，堆回主文件就白分了）
  const leaked = [...new Set([...js.matchAll(/\$\("(purchase[A-Za-z0-9_-]*|tabPurchase)"\)/g)].map((m) => m[1]))];
  if (leaked.length) {
    fails.push(
      `app.js 里出现了进货单的 id（${leaked.join(" / ")}）：它是**独立功能文件**，`
        + "逻辑该待在 purchase.js 里（见那边的文件头注释）",
    );
  }
}

if (fails.length > 0) {
  console.error(`❌ check-mobile-wiring：${fails.length} 项不通过`);
  for (const f of fails) {
    console.error(`   - ${f}`);
  }
  process.exit(1);
}
console.log(
  `✅ check-mobile-wiring：前端脚本（${jsFiles.join(" / ")}）引用的 ${used.size} 个 id 在 index.html 里全部存在、` +
    `且 ${Object.keys(idCount).length} 个 id 无重复` +
    `（豁免 ${DYNAMIC_IDS.size} 个 JS 动态生成的：${[...DYNAMIC_IDS].join(" / ")}）；` +
    `SSE 事件名 ${SERVER_EVENTS.length} 个（${SERVER_EVENTS.join(" / ")}）与服务端一致；` +
    `宽屏抽屉断点前后端一致（${cssBreak ? cssBreak[1] : "?"}px）；` +
    `筛选面板：编号范围不再有第二套入口（已并进搜索行）、折叠状态在 state.openGroups、异步回包走 refreshFilterGroups 避让`,
);
