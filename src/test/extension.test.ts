import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { liveHandlers } from '../tools/shopTool/handlers/live.js';
import { HandlerCtx } from '../tools/shopTool/handlers/types.js';
import { ToolContext } from '../core/toolContext.js';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

suite('直播九宫格输出目录', () => {
	const roots: string[] = [];

	function makeDir(name: string): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cherysis-live-'));
		roots.push(root);
		const dir = path.join(root, name);
		fs.mkdirSync(dir);
		return dir;
	}

	function createHarness(options: {
		savedDir?: string;
		pickDirs?: Array<string | undefined>;
		actions?: Array<string | undefined>;
	}) {
		const settings = new Map<string, string>();
		if (options.savedDir) {
			settings.set('live_out_dir', options.savedDir);
		}
		const pickDirs = [...(options.pickDirs ?? [])];
		const actions = [...(options.actions ?? [])];
		const confirmedDirs: string[] = [];
		const actionLabels: string[][] = [];
		let selectCount = 0;
		const ctx = {
			selectFolder: async () => {
				selectCount += 1;
				return pickDirs.shift();
			},
			chooseAction: async (_message: string, detail: string, labels: string[]) => {
				confirmedDirs.push(detail);
				actionLabels.push(labels);
				return actions.shift();
			},
		} as unknown as ToolContext;
		const h = {
			ctx,
			db: {
				replaceLivePlan: () => undefined,
				getProducts: () => [{ code: 'A001' }],
				setSetting: (key: string, value: string) => {
					settings.set(key, value);
				},
			},
			getSetting: (key: string) => settings.get(key) ?? '',
			log: () => undefined,
			post: () => undefined,
			postLiveState: () => undefined,
		} as unknown as HandlerCtx;
		const msg = { plan: [{ group_no: 1, slot_no: 1, code: 'A001' }] };

		return {
			run: () => liveHandlers(h).generateLiveGrid(msg, h),
			settings,
			confirmedDirs,
			actionLabels,
			get selectCount() {
				return selectCount;
			},
		};
	}

	teardown(() => {
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('已选择有效目录时确认该目录且不再选择', async () => {
		const dir = makeDir('saved');
		const harness = createHarness({ savedDir: dir, actions: ['取消'] });

		await harness.run();

		assert.strictEqual(harness.selectCount, 0);
		assert.deepStrictEqual(harness.confirmedDirs, [dir]);
		assert.deepStrictEqual(harness.actionLabels, [[
			'确定生成',
			'更换目录',
			'取消',
		]]);
	});

	test('未选择目录时先选择再确认', async () => {
		const dir = makeDir('first');
		const harness = createHarness({ pickDirs: [dir], actions: ['取消'] });

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.deepStrictEqual(harness.confirmedDirs, [dir]);
		assert.strictEqual(harness.settings.get('live_out_dir'), dir);
	});

	test('选择更换目录时使用新目录并再次确认', async () => {
		const savedDir = makeDir('saved');
		const nextDir = makeDir('next');
		const harness = createHarness({
			savedDir,
			pickDirs: [nextDir],
			actions: ['更换目录', '取消'],
		});

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.deepStrictEqual(harness.confirmedDirs, [savedDir, nextDir]);
		assert.strictEqual(harness.settings.get('live_out_dir'), nextDir);
	});

	test('原目录已删除时重新选择', async () => {
		const removedDir = makeDir('removed');
		fs.rmSync(removedDir, { recursive: true });
		const nextDir = makeDir('next');
		const harness = createHarness({
			savedDir: removedDir,
			pickDirs: [nextDir],
			actions: ['取消'],
		});

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.deepStrictEqual(harness.confirmedDirs, [nextDir]);
		assert.strictEqual(harness.settings.get('live_out_dir'), nextDir);
	});

	test('无星标生成时回传取消状态', async () => {
		const dir = makeDir('star');
		const messages: any[] = [];
		const h = {
			ctx: {
				selectFolder: async () => undefined,
			},
			db: {
				getLiveStars: () => [],
				getProducts: () => [],
			},
			getSetting: (key: string) => (key === 'image_dir' ? dir : ''),
			post: (message: any) => messages.push(message),
			log: () => undefined,
		} as unknown as HandlerCtx;

		await liveHandlers(h).generateStarOverview({}, h);

		assert.deepStrictEqual(messages, [{ type: 'starOverviewCancelled' }]);
	});

	test('取消选择目录时不打开确认框', async () => {
		const harness = createHarness({ pickDirs: [undefined], actions: ['取消'] });

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.deepStrictEqual(harness.confirmedDirs, []);
		assert.strictEqual(harness.settings.has('live_out_dir'), false);
	});
});
