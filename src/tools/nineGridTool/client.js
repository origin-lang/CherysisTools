// 九宫格工具箱前端逻辑
// 由 main.html 通过 <script> 注入，注册到 window.toolClients["nineGridTool"]
(function () {
  const vscode = window.__vscode || (window.acquireVsCodeApi ? window.acquireVsCodeApi() : null);
  let state = {
    gridItems: new Array(9).fill(null),
    uriMap: {},
    dragSrcIdx: null,
    contextIdx: -1,
    outDir: "",
    labelSrcPath: "",
    labelStartNum: 1,
    labelOutDir: "",
  };
  let pendingMessages = [];
  let pendingItems = [];
  let gridContainer = null;
  let ctxMenu = null;

  function init() {
    state.gridItems = new Array(9).fill(null);
    state.uriMap = {};
    state.dragSrcIdx = null;
    state.contextIdx = -1;
    state.outDir = "";
    state.labelSrcPath = "";
    state.labelStartNum = 1;
    state.labelOutDir = "";
    pendingItems = [];

    const actionMap = {
      openSelectImages: () => post({ type: "openSelectImages", toolName: "nineGridTool" }),
      openLoadImageFolder: () => post({ type: "openLoadImageFolder", toolName: "nineGridTool" }),
      btnClear: () => {
        state.gridItems.fill(null);
        state.uriMap = {};
        state.dragSrcIdx = null;
        renderAll();
      },
      openMergeOutputFolder: () => post({ type: "openMergeOutputFolder", toolName: "nineGridTool", outDir: state.outDir }),
      runMerge: () => post({ type: "runMerge", toolName: "nineGridTool", grid: state.gridItems }),
      selectLabelImage: () => post({ type: "selectLabelImage", toolName: "nineGridTool" }),
      selectLabelOutDir: () => post({ type: "selectLabelOutDir", toolName: "nineGridTool" }),
      openLabelOutputFolder: () => post({ type: "openLabelOutputFolder", toolName: "nineGridTool", targetDir: state.labelOutDir }),
      runLabel: () => {
        const numEl = document.getElementById("labelStartNum");
        state.labelStartNum = parseInt(numEl?.value || "1", 10);
        post({ type: "runLabel", toolName: "nineGridTool", srcPath: state.labelSrcPath, startNum: state.labelStartNum, outDir: state.labelOutDir });
      },
      rotate: () => post({ type: "rotateImage", toolName: "nineGridTool", idx: state.contextIdx, grid: state.gridItems }),
      copy: () => {
        const path = state.gridItems[state.contextIdx];
        if (!path || !state.uriMap[path]) {return;}
        copyImageToClipboard(state.uriMap[path]);
      },
      paste: () => pasteImageFromClipboard(),
      delete: () => {
        state.gridItems[state.contextIdx] = null;
        renderCell(state.contextIdx);
        updateStatus();
      },
    };

    gridContainer = document.getElementById("gridContainer");
    ctxMenu = document.getElementById("ctxMenu");
    const fragmentRoot = document.getElementById("fragmentContainer");
    fragmentRoot.querySelectorAll("[data-action]").forEach((btn) => {
      const act = btn.dataset.action;
      btn.onclick = () => actionMap[act] && actionMap[act]();
    });

    if (gridContainer) {
      gridContainer.innerHTML = "";
      for (let i = 0; i < 9; i++) {
        const cell = document.createElement("div");
        cell.className = "grid-cell normal";
        cell.dataset.idx = i;
        cell.innerHTML = `<div class="grid-img-wrap"><span>空位${i + 1}</span></div><div class="grid-text"></div>`;
        cell.addEventListener("click", (e) => handleCellClick(i, e));
        cell.addEventListener("contextmenu", (e) => handleRightClick(i, e));
        gridContainer.appendChild(cell);
      }
      document.body.onclick = () => {
        if (ctxMenu) {ctxMenu.style.display = "none";}
      };
      gridContainer.addEventListener("dragover", handleGridDragOver);
      gridContainer.addEventListener("dragleave", clearDropOver);
      gridContainer.addEventListener("drop", handleGridDrop);
    }
    document.removeEventListener("paste", handlePasteCapture, true);
    document.addEventListener("paste", handlePasteCapture, true);
    renderAll();
    // 回放缓存消息
    while (pendingMessages.length > 0) {
      onMessage(pendingMessages.shift());
    }
  }

  function post(msg) {
    if (vscode) {vscode.postMessage(msg);}
  }

  function handleCellClick(idx, ev) {
    ev.stopPropagation();
    if (state.dragSrcIdx === null) {
      state.dragSrcIdx = idx;
    } else {
      const src = state.dragSrcIdx;
      if (src !== idx) {
        [state.gridItems[src], state.gridItems[idx]] = [state.gridItems[idx], state.gridItems[src]];
      }
      state.dragSrcIdx = null;
    }
    renderAll();
  }

  function handleRightClick(idx, ev) {
    ev.preventDefault();
    state.contextIdx = idx;
    if (!ctxMenu) {return;}
    const hasImg = state.gridItems[idx] !== null;
    const items = ctxMenu.querySelectorAll("[data-action]");
    for (const it of items) {
      const needImg = it.dataset.action === "rotate" || it.dataset.action === "copy" || it.dataset.action === "delete";
      it.classList.toggle("disabled", needImg && !hasImg);
    }
    ctxMenu.style.left = ev.pageX + "px";
    ctxMenu.style.top = ev.pageY + "px";
    ctxMenu.style.display = "block";
  }

  function clearDropOver() {
    if (!gridContainer) {return;}
    gridContainer.classList.remove("drop-over");
    for (const c of gridContainer.children) {
      c.classList.remove("drop-over");
    }
  }

  function handleGridDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    clearDropOver();
    const cell = e.target && e.target.closest ? e.target.closest(".grid-cell") : null;
    if (cell) {
      cell.classList.add("drop-over");
    } else if (gridContainer) {
      gridContainer.classList.add("drop-over");
    }
  }

  function isImageFile(file) {
    return (
      !!file && typeof file.type === "string" && file.type.startsWith("image/")
    );
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("read error"));
      reader.readAsDataURL(file);
    });
  }

  async function filesToImageItems(fileList) {
    const files = Array.from(fileList || []).filter(isImageFile);
    const items = [];
    for (const f of files) {
      try {
        const data = await readFileAsDataURL(f);
        if (data) {
          items.push({ name: f.name || "", data });
        }
      } catch {
        /* 忽略单张读取失败 */
      }
    }
    return items;
  }

  function collectFiles(dt) {
    const seen = new Set();
    const out = [];
    const add = (f) => {
      if (!f) {
        return;
      }
      const key = `${f.name || ""}|${f.size}|${f.lastModified}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push(f);
    };
    if (dt) {
      if (dt.items) {
        for (const it of Array.from(dt.items)) {
          if (it.kind === "file") {
            add(it.getAsFile());
          }
        }
      }
      if (dt.files) {
        for (const f of Array.from(dt.files)) {
          add(f);
        }
      }
    }
    return out;
  }

  function statusText(text) {
    const el = document.getElementById("statusText");
    if (el) {
      el.textContent = text;
    }
  }

  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
    if (!m) {
      return new Blob();
    }
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: m[1] });
  }

  function readBlobAsDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("read error"));
      reader.readAsDataURL(blob);
    });
  }

  function copyImageToClipboard(dataUrl) {
    try {
      const blob = dataUrlToBlob(dataUrl);
      const type = blob.type || "image/png";
      innerCopy(blob, type);
    } catch (err) {
      statusText("❌复制失败");
    }
  }

  function innerCopy(blob, type) {
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      navigator.clipboard
        .write([new ClipboardItem({ [type]: blob })])
        .then(() => {
          statusText("✅图片已复制，可在任意处粘贴");
        })
        .catch(() => {
          statusText("❌复制失败：剪贴板权限被拒");
        });
      return;
    }
    statusText("❌当前环境不支持复制图片");
  }

  function pasteImageFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      statusText("❌当前环境不支持读取剪贴板");
      return;
    }
    navigator.clipboard
      .read()
      .then((cItems) => {
        if (!cItems || !cItems.length) {
          statusText("剪贴板里没有图片");
          return;
        }
        let handled = false;
        for (const item of cItems) {
          const t = Array.from(item.types || []).find((x) =>
            String(x).toLowerCase().startsWith("image/"),
          );
          if (!t) {
            continue;
          }
          item
            .getType(t)
            .then((blob) => {
              if (!blob) {
                statusText("剪贴板里没有图片");
                return;
              }
              return readBlobAsDataURL(blob).then((data) => {
                if (data) {
                  postImages([{ name: `clipboard_${Date.now()}`, data }], state.contextIdx);
                } else {
                  statusText("剪贴板里没有图片");
                }
              });
            })
            .catch(() => statusText("❌读取剪贴板图片失败"));
          handled = true;
          break;
        }
        if (!handled) {
          statusText("剪贴板里没有图片");
        }
      })
      .catch(() => {
        statusText("❌读取剪贴板失败：权限被拒");
      });
  }

  // 图片以 base64 交给后端落盘（拿到真实路径后才能拼图），先排队，
  // 等 importedImagePaths 回包按顺序配对预览数据
  function postImages(items, targetIdx) {
    if (!items.length) {
      return;
    }
    pendingItems.push(items);
    post({
      type: "importImages",
      toolName: "nineGridTool",
      items,
      targetIdx,
    });
  }

  function handleGridDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDropOver();
    const dt = e.dataTransfer;
    const files = collectFiles(dt);
    const cell =
      e.target && e.target.closest ? e.target.closest(".grid-cell") : null;
    const targetIdx =
      cell && gridContainer
        ? [].indexOf.call(gridContainer.children, cell)
        : -1;
    if (files.length) {
      filesToImageItems(files).then((items) => {
        if (items.length) {
          postImages(items, targetIdx);
        } else {
          statusText("拖入的文件不是图片");
        }
      });
      return;
    }
    const uriList =
      (dt && dt.getData("application/vnd.code.uri-list")) ||
      (dt && dt.getData("text/uri-list")) ||
      "";
    const uris = uriList
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("file://"));
    if (uris.length) {
      post({
        type: "dropImageUris",
        toolName: "nineGridTool",
        uris,
        targetIdx,
      });
    }
  }

  function handlePasteCapture(e) {
    const t = e.target;
    if (
      t &&
      t.closest &&
      t.closest("input,textarea,select,[contenteditable='true']")
    ) {
      return;
    }
    const files = collectFiles(e.clipboardData || window.clipboardData || null);
    if (!files.length) {
      return;
    }
    filesToImageItems(files).then((items) => {
      if (items.length) {
        postImages(items, -1);
      } else {
        statusText("剪贴板里未检测到图片");
      }
    });
    e.preventDefault();
  }

  function updateStatus() {
    const count = state.gridItems.filter((x) => x !== null).length;
    const el = document.getElementById("statusText");
    if (el) {el.textContent = `已填充：${count} / 9`;}
  }

  function renderCell(idx) {
    const cellDom = gridContainer?.children[idx];
    if (!cellDom) {return;}
    const path = state.gridItems[idx];
    cellDom.className = "grid-cell normal";
    if (state.dragSrcIdx === idx) {cellDom.className = "grid-cell selected";}
    const imgWrap = cellDom.querySelector(".grid-img-wrap");
    const textDom = cellDom.querySelector(".grid-text");
    if (path === null) {
      imgWrap.innerHTML = `<span>空位${idx + 1}</span>`;
      textDom.textContent = "";
      return;
    }
    textDom.textContent = path.split("\\").pop().split("/").pop();
    const imgSrc = state.uriMap[path];
    if (imgSrc) {
      imgWrap.innerHTML = `<img src="${imgSrc}" style="max-width:100%;max-height:100%;object-fit:contain;" />`;
    } else {
      imgWrap.innerHTML = `<span>图片加载失败</span>`;
    }
  }

  function renderAll() {
    if (!gridContainer) {return;}
    for (let i = 0; i < 9; i++) {renderCell(i);}
    updateStatus();
  }

  function onMessage(msg) {
    if (msg.type === "addImagePaths") {
      // 合并而非覆盖，保留之前已加载图片的预览数据
      Object.assign(state.uriMap, msg.uriMap);
      for (const p of msg.paths) {
        const emptyIdx = state.gridItems.findIndex((x) => x === null);
        if (emptyIdx === -1) {break;}
        state.gridItems[emptyIdx] = p;
      }
      renderAll();
    } else if (msg.type === "setOutputDir") {
      state.outDir = msg.path;
      const btn = document.getElementById("btnOpenOut");
      if (btn) {btn.disabled = false;}
    } else if (msg.type === "importedImagePaths") {
      const paths = Array.isArray(msg.paths) ? msg.paths : [];
      if (paths.length) {
        if (msg.uriMap) {
          Object.assign(state.uriMap, msg.uriMap);
        }
        const items = pendingItems.shift() || [];
        for (let i = 0; i < paths.length; i++) {
          if (i < items.length && items[i] && items[i].data) {
            state.uriMap[paths[i]] = items[i].data;
          }
        }
        const ti = Number(msg.targetIdx);
        const target = Number.isInteger(ti) && ti >= 0 && ti < 9 ? ti : null;
        if (target !== null) {
          state.gridItems[target] = paths[0];
        }
        const rest = target !== null ? paths.slice(1) : paths;
        for (const p of rest) {
          const emptyIdx = state.gridItems.findIndex((x) => x === null);
          if (emptyIdx === -1) {
            break;
          }
          state.gridItems[emptyIdx] = p;
        }
        renderAll();
      }
    } else if (msg.type === "setLabelOutDir") {
      state.labelOutDir = msg.path;
      const el = document.getElementById("labelOutDirInput");
      if (el) {el.value = msg.path;}
    } else if (msg.type === "setLabelImage") {
      state.labelSrcPath = msg.path;
      const previewBox = document.getElementById("labelPreviewBox");
      if (previewBox && msg.base64) {
        previewBox.innerHTML = `<img src="${msg.base64}" style="max-width:100%;max-height:100%;object-fit:contain;" />`;
      }
      const inputEl = document.getElementById("labelSrcInput");
      if (inputEl) {inputEl.value = msg.path;}
    } else if (msg.type === "rotatedCellUpdate") {
      state.uriMap[msg.filePath] = msg.newBase64;
      renderCell(msg.idx);
    }
  }

  window.toolClients = window.toolClients || {};
  window.toolClients["nineGridTool"] = {
    init,
    onMessage,
    _state: state,
    _isReady: function () { return gridContainer !== null; },
  };
})();
