const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "docs", "shopTool-测试清单.md");
const OUT = path.join(__dirname, "..", "docs", "shopTool-测试清单.html");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmt(s) {
  let t = esc(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  return t;
}

const lines = fs.readFileSync(SRC, "utf8").split(/\r?\n/);

const modules = [];
let curModule = null;
let curCase = null;
let curField = null;

for (const raw of lines) {
  const line = raw.replace(/\t/g, "    ");
  if (/^## M\d{2} /.test(line)) {
    curModule = {
      id: line.match(/^## (M\d{2}) /)[1],
      title: line.replace(/^## M\d{2} /, ""),
      cases: [],
    };
    modules.push(curModule);
    curCase = null;
    continue;
  }
  if (!curModule) continue;
  const m = line.match(/^### (P-M\d{2}-\d{2}) (.+)$/);
  if (m) {
    curCase = {
      id: m[1],
      title: m[2],
      prio: "P2",
      pre: "",
      steps: [],
      expect: "",
    };
    curModule.cases.push(curCase);
    curField = null;
    continue;
  }
  if (!curCase) continue;
  const pri = line.match(/^[-*] 优先级：P(\d)/);
  if (pri) {
    curCase.prio = "P" + pri[1];
    curField = null;
    continue;
  }
  if (line.startsWith("- 前置：")) {
    curCase.pre = line.slice("- 前置：".length).trim();
    curField = "pre";
    continue;
  }
  if (line.startsWith("- 步骤：")) {
    curField = "steps";
    continue;
  }
  if (line.startsWith("- 预期：")) {
    curCase.expect = line.slice("- 预期：".length).trim();
    curField = "expect";
    continue;
  }
  if (line.startsWith("- 记录：")) {
    curField = "record";
    continue;
  }
  if (curField === "steps") {
    const st = line.match(/^\s{2,}(\d+)\.\s+(.+)$/);
    if (st) {
      curCase.steps.push(st[2].trim());
      curField = "steps";
    } else if (/^\S/.test(line)) {
      // 意外非步骤行：忽略
    }
  }
}

const count = modules.reduce((n, mo) => n + mo.cases.length, 0);

const data = modules.map((mo) => ({
  id: mo.id,
  title: mo.title,
  cases: mo.cases.map((c) => ({ ...c, status: "todo", remark: "" })),
}));

let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>shopTool 测试清单</title>
<style>
:root{
  --bg:#0f1117; --panel:#171a21; --panel2:#1d212b; --line:#2a2f3a;
  --fg:#e6e9ef; --muted:#8b93a3; --accent:#4f9cf9;
  --ok:#3fb950; --bad:#f85149; --todo:#8b93a3; --na:#6b7688;
  --p0:#f85149; --p1:#d29922; --p2:#4f9cf9;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
header{position:sticky;top:0;z-index:10;background:linear-gradient(#1a1e27,#14171e);border-bottom:1px solid var(--line);padding:12px 20px}
h1{margin:0;font-size:18px}
h1 .meta{color:var(--muted);font-weight:400;font-size:12px;margin-left:8px}
.bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:10px}
.stats{display:flex;gap:14px;flex-wrap:wrap}
.stat{font-size:12px;color:var(--muted)}
.stat b{font-size:16px;color:var(--fg);display:block;line-height:1.2}
.stat.good b{color:var(--ok)} .stat.bad b{color:var(--bad)}
.track{flex:1;min-width:160px;height:8px;border-radius:4px;background:#242936;overflow:hidden;display:flex}
.track i{display:block;height:100%}
.track .ok{background:var(--ok)} .track .bad{background:var(--bad)} .track .na{background:var(--na)}
.controls{display:flex;gap:8px;flex-wrap:wrap}
button{background:var(--panel2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:13px}
button:hover{border-color:#3a4150}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
input[type=text],input[type=search]{background:var(--panel2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:5px 10px;font-size:13px}
input[type=text]{width:100%}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{padding:3px 10px;border-radius:999px;border:1px solid var(--line);font-size:12px;cursor:pointer;background:var(--panel2)}
.chip.on{color:#fff;border-color:transparent}
.chip.ch-todo.on{background:var(--todo)} .chip.ch-pass.on{background:var(--ok)} .chip.ch-fail.on{background:var(--bad)} .chip.ch-na.on{background:var(--na)}
main{max-width:1180px;margin:0 auto;padding:16px 20px 80px}
#searchWrap{margin:14px 0;display:flex;gap:8px;align-items:center}
#searchWrap input{flex:1}
.module{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:14px;overflow:hidden}
.module-head{display:flex;align-items:center;gap:12px;padding:11px 16px;cursor:pointer;user-select:none}
.module-head:hover{background:#1b1f29}
.module-head .mid{font-weight:700;color:var(--accent);letter-spacing:.5px}
.module-head .mtitle{font-weight:600}
.module-head .mprog{margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap}
.chev{transition:transform .15s;color:var(--muted)}
.module.open .chev{transform:rotate(90deg)}
.module-cases{display:none;border-top:1px solid var(--line)}
.module.open .module-cases{display:block}
.case{border-bottom:1px solid #222733;padding:12px 16px}
.case:last-child{border-bottom:none}
.case-head{display:flex;align-items:center;gap:10px;cursor:pointer;flex-wrap:wrap}
.cid{font-family:Consolas,monospace;color:var(--accent);font-size:12px;background:#141821;padding:2px 6px;border-radius:4px}
.ctitle{font-weight:600}
.prio{font-size:11px;padding:1px 7px;border-radius:999px;font-weight:700}
.prio.p0{background:rgba(248,81,73,.15);color:var(--p0)}
.prio.p1{background:rgba(210,153,34,.15);color:var(--p1)}
.prio.p2{background:rgba(79,156,249,.15);color:var(--p2)}
.st{display:flex;gap:6px;margin-left:auto}
.st button{font-size:12px;padding:3px 9px;border-radius:6px}
.st button.todo{color:var(--todo)} .st button.pass{color:var(--ok)} .st button.fail{color:var(--bad)} .st button.na{color:var(--na)}
.st button.on{background:currentColor}
.st button.on{color:#0f1117}
.st button.on.todo{background:var(--todo)} .st button.on.pass{background:var(--ok)} .st button.on.fail{background:var(--bad)} .st button.on.na{background:var(--na)}
.case-body{display:none;margin-top:8px;color:#c8cede}
.case.open .case-body{display:block}
.row{margin:4px 0}
.lab{color:var(--muted);font-size:12px;width:64px;display:inline-block;vertical-align:top;flex-shrink:0}
.det{display:flex}
ol{margin:2px 0;padding-left:20px}
code{background:#10141c;border:1px solid var(--line);border-radius:4px;padding:0 4px;font-family:Consolas,monospace;font-size:12px;color:#7ee787}
.remark-row{display:flex;gap:8px;align-items:center;margin-top:8px}
.remark-row input{flex:1}
#defects{max-width:1180px;margin:20px auto 0;padding:0 20px}
#defects .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #222733;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#1b1f29}
td input,td select{width:100%}
footer{max-width:1180px;margin:10px auto;padding:20px;color:var(--muted);font-size:12px}
.empty{color:var(--muted);text-align:center;padding:30px}
</style>
</head>
<body>
<header>
  <h1>🏪 shopTool 测试清单<span class="meta">版本 0.0.8 · 归档二十五 · 共 ${count} 条 · 本地自动保存</span></h1>
  <div class="bar">
    <div class="stats">
      <div class="stat"><b id="sTotal">${count}</b>总用例</div>
      <div class="stat"><b id="sPass">0</b>通过</div>
      <div class="stat"><b id="sFail">0</b>失败</div>
      <div class="stat"><b id="sTodo">${count}</b>待测</div>
      <div class="stat"><b id="sNa">0</b>不适用</div>
    </div>
    <div class="track" title="通过 / 失败 / 不适用"><i class="ok" id="pOk"></i><i class="bad" id="pBad"></i><i class="na" id="pNa"></i></div>
    <div class="controls">
      <button onclick="resetAll()">重置记录</button>
      <button onclick="expandAll(true)">全部展开</button>
      <button onclick="expandAll(false)">全部收起</button>
      <button class="primary" onclick="exportReport()">导出报告</button>
    </div>
  </div>
  <div id="searchWrap">
    <input type="search" id="search" placeholder="搜索用例：编号 / 标题 / 预期 关键词" />
    <div class="chips" id="statusChips">
      <span class="chip on" data-f="all">全部</span>
      <span class="chip ch-todo" data-f="todo">待测</span>
      <span class="chip ch-pass" data-f="pass">通过</span>
      <span class="chip ch-fail" data-f="fail">失败</span>
      <span class="chip ch-na" data-f="na">不适用</span>
    </div>
  </div>
</header>
<main id="app"></main>

<div id="defects">
  <div class="panel">
    <h3 style="margin:0 0 10px">附录 A · 缺陷登记表</h3>
    <div style="margin-bottom:8px"><button onclick="addDefect()">＋ 添加缺陷</button></div>
    <table id="defectTable">
      <thead><tr><th style="width:60px">缺陷#</th><th style="width:70px">模块</th><th style="width:80px">严重度</th><th style="width:120px">用例ID</th><th>描述</th><th>复现步骤</th><th>预期 vs 实际</th><th style="width:80px">状态</th><th style="width:44px"></th></tr></thead>
      <tbody id="defectRows"></tbody>
    </table>
    <p style="color:var(--muted);font-size:12px;margin:10px 0 0">导出报告会把缺陷表一并写入。</p>
  </div>
</div>

<footer>数据保存在浏览器 localStorage（key: <code>shopTool-checklist-v0.8</code>）。清单内容由 <code>scripts/genShopTestChecklist.cjs</code> 从 <code>docs/shopTool-测试清单.md</code> 生成。</footer>

<script>
var DATA = __DATA__;
var KEY = "shopTool-checklist-v0.8";
var statusFilter = "all";
var keyword = "";

function loadState(){
  try{
    var raw = localStorage.getItem(KEY);
    if(!raw) return;
    var saved = JSON.parse(raw);
    if(!saved || !saved.v || saved.v !== "0.8") return;
    saved.data.forEach(function(mod){
      var t = DATA.find(function(m){return m.id===mod.id});
      if(!t) return;
      mod.cases.forEach(function(c){
        var d = t.cases.find(function(x){return x.id===c.id});
        if(d){ d.status=c.status||"todo"; d.remark=c.remark||""; }
      });
    });
  }catch(e){}
}
function saveState(){
  try{ localStorage.setItem(KEY, JSON.stringify({v:"0.8", data:DATA})); }catch(e){}
}

function fmtBody(s){
  if(!s) return s;
  var e = $esc(s);
  e = e.replace(/\\*\\*([^\\*]+)\\*\\*/g, "<b>$1</b>");
  e = e.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
  return e;
}
function $esc(s){
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function render(){
  var q = keyword.toLowerCase();
  var app = document.getElementById("app");
  var html = "";
  DATA.forEach(function(mod){
    var cases = mod.cases.filter(function(c){
      if(statusFilter !== "all" && c.status !== statusFilter) return false;
      if(q){
        var hay = (c.id+" "+c.title+" "+c.pre+" "+c.steps.join(" ")+" "+c.expect).toLowerCase();
        if(hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var pc = {pass:0, fail:0, todo:0, na:0};
    mod.cases.forEach(function(c){ pc[c.status]=(pc[c.status]||0)+1; });
    if(cases.length===0) return;
    html += '<div class="module" data-mid="'+mod.id+'" data-open="1">'
      + '<div class="module-head" data-toggle="module">'
      + '<span class="chev">▶</span><span class="mid">'+mod.id+'</span><span class="mtitle">'+$esc(mod.title)+'</span>'
      + '<span class="mprog">'+pc.pass+'/'+mod.cases.length+' 已测'+'</span></div>'
      + '<div class="module-cases">';
    cases.forEach(function(c){
      var stepHtml = "";
      if(c.steps && c.steps.length){
        stepHtml = '<div class="row det"><span class="lab">步骤</span><ol>' + c.steps.map(function(s){return "<li>"+fmtBody(s)+"</li>";}).join("") + '</ol></div>';
      }
      var preHtml = c.pre ? '<div class="row det"><span class="lab">前置</span><span>'+fmtBody(c.pre)+'</span></div>' : "";
      var expHtml = c.expect ? '<div class="row det"><span class="lab">预期</span><span>'+fmtBody(c.expect)+'</span></div>' : "";
      var rm = c.remark ? ' value="'+$esc(c.remark).replace(/"/g,"&quot;")+'"' : "";
      html += '<div class="case" data-id="'+c.id+'">'
        + '<div class="case-head" data-toggle="case">'
        + '<span class="cid">'+c.id+'</span><span class="ctitle">'+$esc(c.title)+'</span>'
        + '<span class="prio '+c.prio.toLowerCase()+'">'+c.prio+'</span>'
        + '<span class="st">'
        +   '<button class="todo'+(c.status==="todo"?" on":"")+'" data-set-status="todo" data-id="'+c.id+'">待测</button>'
        +   '<button class="pass'+(c.status==="pass"?" on":"")+'" data-set-status="pass" data-id="'+c.id+'">通过</button>'
        +   '<button class="fail'+(c.status==="fail"?" on":"")+'" data-set-status="fail" data-id="'+c.id+'">失败</button>'
        +   '<button class="na'+(c.status==="na"?" on":"")+'" data-set-status="na" data-id="'+c.id+'">不适用</button>'
        + '</span></div>'
        + '<div class="case-body">' + preHtml + stepHtml + expHtml
        + '<div class="remark-row"><span class="lab">备注</span><input type="text" placeholder="记录实际结果 / 差异" data-rm="'+c.id+'"'+rm+' /></div>'
        + '</div></div>';
    });
    html += '</div></div>';
  });
  app.innerHTML = html || '<div class="empty">没有匹配的用例</div>';
}

function setStatus(id, st){
  var c = findCase(id);
  if(c){ c.status = st; saveState(); render(); updateStats(); }
}
function setRemark(id, val){
  var c = findCase(id);
  if(c){ c.remark = val; saveState(); }
}
function findCase(id){
  for(var i=0;i<DATA.length;i++){
    for(var j=0;j<DATA[i].cases.length;j++){
      if(DATA[i].cases[j].id === id) return DATA[i].cases[j];
    }
  }
  return null;
}
function toggleModule(head){
  var mod = head.parentNode;
  mod.classList.toggle("open");
}
function toggleCase(head){
  head.parentNode.classList.toggle("open");
}
document.getElementById("app").addEventListener("click", function(e){
  var btn = e.target.closest("[data-set-status]");
  if(btn){ setStatus(btn.dataset.id, btn.dataset.setStatus); return; }
  var tog = e.target.closest("[data-toggle]");
  if(tog){ (tog.dataset.toggle === "module" ? toggleModule : toggleCase)(tog); }
});
function expandAll(open){
  document.querySelectorAll(".module").forEach(function(m){ m.classList.toggle("open", open); });
  document.querySelectorAll(".case").forEach(function(c){ c.classList.toggle("open", open); });
}
function updateStats(){
  var pass=0,fail=0,todo=0,na=0;
  DATA.forEach(function(m){ m.cases.forEach(function(c){
    if(c.status==="pass")pass++; else if(c.status==="fail")fail++; else if(c.status==="na")na++; else todo++;
  }); });
  document.getElementById("sPass").textContent=pass;
  document.getElementById("sFail").textContent=fail;
  document.getElementById("sTodo").textContent=todo;
  document.getElementById("sNa").textContent=na;
  var total=pass+fail+todo+na || 1;
  document.getElementById("pOk").style.width=Math.round(pass/total*100)+"%";
  document.getElementById("pBad").style.width=Math.round(fail/total*100)+"%";
  document.getElementById("pNa").style.width=Math.round(na/total*100)+"%";
}

document.getElementById("search").addEventListener("input", function(e){ keyword=e.target.value.trim(); render(); });
document.querySelectorAll("#statusChips .chip").forEach(function(ch){
  ch.addEventListener("click", function(){
    document.querySelectorAll("#statusChips .chip").forEach(function(x){x.classList.remove("on");});
    ch.classList.add("on");
    statusFilter = ch.dataset.f;
    render();
  });
});
document.getElementById("app").addEventListener("input", function(e){
  var t = e.target;
  if(t.dataset && t.dataset.rm) setRemark(t.dataset.rm, t.value);
});

function resetAll(){
  if(!confirm("确定重置所有用例为『待测』并清空备注？")) return;
  DATA.forEach(function(m){ m.cases.forEach(function(c){ c.status="todo"; c.remark=""; }); });
  saveState(); render(); updateStats();
}

/* ---- 缺陷登记 ---- */
function addDefect(){
  var tb = document.getElementById("defectRows");
  var tr = document.createElement("tr");
  var inputs = ["#","模块","严重度","用例ID","描述","复现步骤","预期vs实际"];
  tr.appendChild(td(input('dnum','')));
  tr.appendChild(td(input('dmod','')));
  tr.appendChild(td(sel([["高","高"],["中","中"],["低","低"]], "中")));
  tr.appendChild(td(input('dcase','')));
  tr.appendChild(td(input('ddesc','')));
  tr.appendChild(td(input('dsteps','')));
  tr.appendChild(td(input('devs','')));
  tr.appendChild(td(sel([["待处理","待处理"],["已修复","已修复"],["已关闭","已关闭"]], "待处理")));
  var del = document.createElement("button"); del.textContent="删"; del.onclick=function(){ tb.removeChild(tr); saveDefects(); };
  var tdD = document.createElement("td"); tdD.appendChild(del); tr.appendChild(tdD);
  tr.dataset.key = 'd'+Date.now()+Math.floor(Math.random()*999);
  tb.appendChild(tr);
}
function td(node){ var t=document.createElement("td"); t.appendChild(node); return t; }
function input(cls, val){ var i=document.createElement("input"); if(cls)i.className=cls; i.value=val||""; i.addEventListener("input", saveDefects); return i; }
function sel(opts, cur){
  var s=document.createElement("select");
  opts.forEach(function(o){
    var op=document.createElement("option"); op.value=o[1]; op.textContent=o[0];
    if(o[1]===cur) op.selected=true;
    s.appendChild(op);
  });
  s.addEventListener("change", saveDefects);
  return s;
}
function collectDefects(){
  var rows = [];
  document.querySelectorAll("#defectRows tr").forEach(function(tr){
    var cells = tr.querySelectorAll("td");
    if(!cells.length) return;
    var vals=[];
    cells.forEach(function(c){ var inp=c.querySelector("input,select"); vals.push(inp?inp.value.trim():""); });
    if(vals.join("").trim()) rows.push(vals.slice(0,8));
  });
  return rows;
}
function saveDefects(){ try{ localStorage.setItem(KEY+"-defects", JSON.stringify(collectDefects())); }catch(e){} }
function loadDefects(){
  try{
    var raw=localStorage.getItem(KEY+"-defects"); if(!raw) return;
    var rows=JSON.parse(raw);
    rows.forEach(function(r){
      addDefect();
      var trs=document.querySelectorAll("#defectRows tr");
      var tr=trs[trs.length-1];
      var cells=tr.querySelectorAll("td");
      cells.forEach(function(c,i){ var inp=c.querySelector("input"); if(inp) inp.value=(r[i]||""); });
    });
  }catch(e){}
}

/* ---- 导出报告 ---- */
function exportReport(){
  var pass=0,fail=0,todo=0,na=0;
  DATA.forEach(function(m){ m.cases.forEach(function(c){
    if(c.status==="pass")pass++; else if(c.status==="fail")fail++; else if(c.status==="na")na++; else todo++;
  }); });
  var now = new Date().toLocaleString("zh-CN");
  var md = "# shopTool 测试报告\\n\\n生成时间："+now+"\\n\\n总计 "+pass+fail+todo+na+" 条：通过 "+pass+" · 失败 "+fail+" · 待测 "+todo+" · 不适用 "+na+"\\n\\n";
  md += "通过率："+Math.round(pass/(pass+fail+todo||1)*100)+"%（不含不适用）\\n\\n";
  md += "## 失败清单\\n\\n";
  var failLines=[];
  DATA.forEach(function(m){
    m.cases.forEach(function(c){
      if(c.status==="fail"){
        failLines.push("- ["+c.id+"] "+c.title+(c.remark?"（备注："+c.remark+"）":""));
      }
    });
  });
  md += failLines.length? failLines.join("\\n")+"\\n" : "（无）\\n";
  md += "\\n## 待测清单\\n\\n";
  var todoLines=[];
  DATA.forEach(function(m){
    m.cases.forEach(function(c){
      if(c.status==="todo"){ todoLines.push("- ["+c.id+"] "+c.title); }
    });
  });
  md += todoLines.length? todoLines.join("\\n")+"\\n" : "（无）\\n";
  md += "\\n## 通过情况（按模块）\\n\\n| 模块 | 通过 | 失败 | 不适用 | 待测 |\\n|---|---|---|---|---|\\n";
  DATA.forEach(function(m){
    var p=0,f=0,n=0,t=0;
    m.cases.forEach(function(c){ if(c.status==="pass")p++; else if(c.status==="fail")f++; else if(c.status==="na")n++; else t++; });
    md += "| "+m.id+" | "+p+" | "+f+" | "+n+" | "+t+" |\\n";
  });
  var defs=collectDefects();
  md += "\\n## 缺陷登记\\n\\n";
  if(defs.length){ md += "| 缺陷# | 模块 | 严重度 | 用例ID | 描述 | 复现步骤 | 预期vs实际 | 状态 |\\n|---|---|---|---|---|---|---|---|\\n"; defs.forEach(function(d){ md += "| "+d.join(" | ")+" |\\n"; }); }
  else md += "（无）\\n";
  var blob = new Blob([md], {type:"text/markdown;charset=utf-8"});
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "shopTool测试报告-"+new Date().toISOString().slice(0,10)+".md";
  a.click();
  URL.revokeObjectURL(a.href);
}

loadState();
render();
updateStats();
loadDefects();
</script>
</body>
</html>
`;

html = html.replace("__DATA__", JSON.stringify(data));

fs.writeFileSync(OUT, html, "utf8");
console.log("OK: " + OUT + " (" + count + " cases in " + modules.length + " modules)");