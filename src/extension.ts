import * as vscode from "vscode";
import { toolRegistry } from "./core/toolRegistry.js";
import { imageBatchTool } from "./tools/imageBatchTool/index.js";
import { nineGridTool } from "./tools/nineGridTool/index.js";
import { excelAnalyzeTool } from "./tools/excelAnalyzeTool/index.js";
import { procurementTool } from "./tools/procurementTool/index.js";
import { shopTool } from "./tools/shopTool/index.js";
import { order1688Tool } from "./tools/order1688Tool/index.js";

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
  );
}

export function deactivate() {}
