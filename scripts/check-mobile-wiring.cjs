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

/** JS 动态创建、HTML 里本来就没有的 id */
// 注：套装那块（#dSetSum / #dSetListCard / dSetCount / dSetList / setAddToggle / setAddBtn / setAddCode）
// 现在**骨架全在 index.html 里**，不再由 renderSetList 拼 —— 所以不在豁免名单里，会被正常核对。
const DYNAMIC_IDS = new Set(["codeQ", "codeQGroup", "fsInput"]);

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
const used = new Set();
for (const m of js.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) {
  used.add(m[1]);
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
  fails.push(`app.js 里只认出 ${used.size} 个 $("...")（正常应有 80 多个）：写法变了？这条闸门就失效了`);
}
for (const id of [...used].filter((i) => !have.has(i) && !DYNAMIC_IDS.has(i)).sort()) {
  fails.push(`app.js 用了 $("#${id}")，但 index.html 里没有 id="${id}" —— 点了没反应就是这么来的`);
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
  for (const need of ["body.drawer #screen-list", "body.drawer #status", "body.drawer #toast"]) {
    if (!css.includes(need)) {
      fails.push(`style.css 里缺少 "${need}"：抽屉会盖住那一块（分页按钮/状态条/提示浮层）`);
    }
  }
  // 筛选抽屉（宽屏时也从右边出）同样必须让位，否则分页按钮/状态条会被压住
  for (const need of [
    "body.filterdrawer #screen-list",
    "body.filterdrawer #status",
    "body.filterdrawer #toast",
    "body.filterdrawer #filterPanel",
  ]) {
    if (!css.includes(need)) {
      fails.push(`style.css 里缺少 "${need}"：宽屏筛选抽屉会盖住那一块或整屏铺开`);
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

// ---------- ④ 筛选面板：编号输入框不许被异步重画冲掉 ----------
// 真机才暴露、而且不报错的一条（手机版「编号范围填了没反应」的真凶）：
// 「打开筛选」会紧接着 requestImgStats()，等 imageStatsLoaded 回来时如果**整块**重画 filterBody，
// 用户正在编号框里打的那半截字连同焦点一起没了 —— 电脑上几乎遇不到，因为桌面版那个面板不是这么重画的。
// 闸门：① id="codeQ" 只能出现在 renderFilterCodeInput() 里（别处重建就是又踩坑）；
//       ② 异步回来的那条路必须走 refreshFilterGroups()，不许调 renderFilter()。
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

const codeInputFn = fnBody("renderFilterCodeInput");
const renderFilterFn = fnBody("renderFilter");
const refreshGroupsFn = fnBody("refreshFilterGroups");
if (!codeInputFn || !renderFilterFn || !refreshGroupsFn) {
  fails.push(
    "筛选面板的重画函数改名/挪走了（renderFilterCodeInput / renderFilter / refreshFilterGroups）："
      + "这条闸门就失效了，请同步更新 check-mobile-wiring.cjs",
  );
} else {
  // ① codeQ 这个输入框只能有一个出处
  const codeQHits = [...js.matchAll(/id="codeQ"/g)].length;
  if (codeQHits !== 1 || !codeInputFn.includes('id="codeQ"')) {
    fails.push(
      `id="codeQ" 在 app.js 里出现了 ${codeQHits} 次（应恰好 1 次，且在 renderFilterCodeInput 里）——`
        + "多一处重建就会把用户正在打的编号表达式冲掉",
    );
  }
  // ② renderFilterGroups 不许重建输入框
  if (fnBody("renderFilterGroups").includes('id="codeQ"')) {
    fails.push("renderFilterGroups 里不该出现 id=\"codeQ\"：它只负责圆片，重建输入框会打断用户输入");
  }
  // ③ 图片统计那条异步路必须避让
  // 取 imageStatsLoaded 之后的一段窗口即可（不写贪心正则：缩进/分支写法一改就假红）
  const statsIdx = js.indexOf('"imageStatsLoaded"');
  if (statsIdx < 0) {
    fails.push("找不到 imageStatsLoaded 的处理分支（写法变了？这条闸门就失效了）");
  } else {
    const statsBlock = js.slice(statsIdx, statsIdx + 600);
    if (/renderFilter\(\)/.test(statsBlock)) {
      fails.push(
        "imageStatsLoaded 那条异步回包里调了 renderFilter()：手机上回包常落在用户打字中间，"
          + "会把编号输入框整块重建、字和焦点一起丢。应改调 refreshFilterGroups()",
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

if (fails.length > 0) {
  console.error(`❌ check-mobile-wiring：${fails.length} 项不通过`);
  for (const f of fails) {
    console.error(`   - ${f}`);
  }
  process.exit(1);
}
console.log(
  `✅ check-mobile-wiring：app.js 引用的 ${used.size} 个 id 在 index.html 里全部存在、且 ${Object.keys(idCount).length} 个 id 无重复` +
    `（豁免 ${DYNAMIC_IDS.size} 个 JS 动态生成的：${[...DYNAMIC_IDS].join(" / ")}）；` +
    `SSE 事件名 ${SERVER_EVENTS.length} 个（${SERVER_EVENTS.join(" / ")}）与服务端一致；` +
    `宽屏抽屉断点前后端一致（${cssBreak ? cssBreak[1] : "?"}px）；` +
    `筛选面板的编号输入框只由 renderFilterCodeInput 建、异步回包走 refreshFilterGroups 避让`,
);
