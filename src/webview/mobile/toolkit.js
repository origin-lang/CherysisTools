// 手机版「工具箱」—— **独立功能文件**，2026-10-20。
//
// 是什么：底部 tab 第 5 格「🧰 工具」点开的那个页面。以后的小工具都挂在这儿，
// 每个工具还是自己的 js/css（模块化规矩不变），这里只负责"把工具列出来 + 点进去"。
//
// 怎么加一个新工具（两步，不许往本文件里写业务）：
//   1. 自己的功能文件里调 window.Cherysis.registerScreen("screen-xxx", "tabTools")；
//   2. 在下面 TOOLS 表里加一行 { id, icon, name, desc, screen }。
// 想整体摘掉工具箱：删本文件 + toolkit.css + retcheck 系文件 + index.html 里
// #screen-tools / #screen-retcheck 两屏、#tabTools 那格、对应的 css/script 引入行。
(function () {
  "use strict";

  var API = window.Cherysis;
  if (!API) {
    return;
  }
  var $ = API.$;
  var esc = API.esc;

  /**
   * 工具注册表：这里加一行，#toolList 里就多一张卡。
   * screen 是功能自己 registerScreen 过的屏幕 id —— 点卡片就切过去。
   */
  var TOOLS = [
    {
      id: "retcheck",
      icon: "📦",
      name: "退货核对",
      desc: "粘一批要退的条码，连续扫：红的挑出来，绿的下一个",
      screen: "screen-retcheck",
    },
  ];

  function render() {
    var host = $("toolList");
    if (!host) {
      return;
    }
    host.innerHTML = TOOLS.map(function (t) {
      return (
        '<button class="tool-card" type="button" data-tool="' +
        esc(t.id) +
        '">' +
        '<span class="tc-ic">' +
        esc(t.icon) +
        "</span>" +
        '<span class="tc-main">' +
        '<span class="tc-name">' +
        esc(t.name) +
        "</span>" +
        '<span class="tc-desc">' +
        esc(t.desc) +
        "</span>" +
        "</span>" +
        '<span class="tc-go">›</span>' +
        "</button>"
      );
    }).join("");
    // ⚠️ 每次重画都要重挂（render 重建了 DOM，旧闭包全没了）
    host.querySelectorAll("[data-tool]").forEach(function (b) {
      b.onclick = function () {
        var t = TOOLS.filter(function (x) {
          return x.id === this.dataset.tool;
        }, this)[0];
        if (t) {
          API.show(t.screen);
        }
      };
    });
  }

  // 本屏归底部「工具」那格亮
  API.registerScreen("screen-tools", "tabTools");

  var tab = $("tabTools");
  if (tab) {
    tab.onclick = function () {
      API.show("screen-tools");
    };
  }

  render();
})();
