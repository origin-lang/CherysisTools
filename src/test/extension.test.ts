import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import sharp from 'sharp';
import { liveHandlers } from '../tools/shopTool/handlers/live.js';
import { imageHandlers } from '../tools/shopTool/handlers/image.js';
import { settingsHandlers } from '../tools/shopTool/handlers/settings.js';
import { HandlerCtx } from '../tools/shopTool/handlers/types.js';
import { ToolContext } from '../core/toolContext.js';
import { LOCAL_PREF_KEYS, withBackupTimeout } from '../tools/shopTool/index.js';
import { previewThumbPath, drainInflightThumbs, listImageFiles, thumbToCachedBase64, sharedThumbReady, sharedThumbRoot } from '../tools/shopTool/images.js';
import { renderStarOverviewBuffer, renderLiveGrid } from '../tools/shopTool/liveGrid.js';
import {
	handleNineGridLabel,
	handleNineGridMergeFromList,
	rotateImageInPlace,
} from '../tools/nineGridTool/index.js';
import { productHandlers } from '../tools/shopTool/handlers/product.js';
import { closeDB, getDB, initDB } from '../tools/shopTool/db.js';

/**
 * 测试用的临时根：所有套件的临时目录都建在这一个父目录下，不去 %TEMP% 顶层撒。
 * 一轮测试原本要在顶层建+删十几个目录，那些增删会惊动任何在 %TEMP% 上的东西
 * （资源管理器窗口、搜索索引、第三方 shell 扩展），Windows 会为「刚被删掉的目录」
 * 弹「不可用」框 —— 那是环境在反应，不是测试在弹窗。收进一个父目录后顶层每次只多一个。
 */
const TEST_TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cherysis-tests-'));
process.on('exit', () => {
	try {
		fs.rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* 留给系统清理 */
	}
});

/** 在专用父目录下建一个临时目录；prefix 只用于目录名可读性 */
function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(TEST_TMP_ROOT, prefix));
}

/**
 * 删临时目录。Windows 上文件只要还被 libvips 之类留下进程级映射就会 EPERM/EBUSY，
 * 而 `force: true` 只挡 ENOENT、挡不住这两个 —— 裸 rmSync 会在删到一半时炸掉，
 * 留下一个半删的目录。重试几次，仍不行就留给系统清理（绝不能让整条 suite 变红）。
 */
function removeTempDir(root: string): void {
	for (let i = 0; i < 5; i++) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
			return;
		} catch {
			/* 再试一次 */
		}
	}
}

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
		const root = makeTempDir('live-');
		roots.push(root);
		const dir = path.join(root, name);
		fs.mkdirSync(dir);
		return dir;
	}

	function createHarness(options: {
		savedDir?: string;
		pickDirs?: Array<string | undefined>;
		actions?: Array<string | undefined>;
		readOnly?: boolean;
	}) {
		// settings = 共享库 shop.db 里的 settings 表；prefs = 本机 globalState。
		// 分成两个是为了能断言「个人偏好没写进共享库」——这正是这轮改造的重点。
		const settings = new Map<string, string>();
		const prefs = new Map<string, string>();
		if (options.savedDir) {
			prefs.set('live_out_dir', options.savedDir);
		}
		const pickDirs = [...(options.pickDirs ?? [])];
		const actions = [...(options.actions ?? [])];
		const confirmedDirs: string[] = [];
		const actionLabels: string[][] = [];
		const statuses: any[] = [];
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
			// 与 index.ts 的分流一致：个人偏好读本机，其余读共享库
			getSetting: (key: string) => (LOCAL_PREF_KEYS.has(key) ? prefs.get(key) ?? '' : settings.get(key) ?? ''),
			setSetting: async (key: string, value: string) => {
				(LOCAL_PREF_KEYS.has(key) ? prefs : settings).set(key, value);
			},
			localPrefKey: (key: string) => LOCAL_PREF_KEYS.has(key),
			readOnly: () => options.readOnly === true,
			imageDir: () => '',
			log: () => undefined,
			post: (message: any) => {
				statuses.push(message);
			},
			postLiveState: () => undefined,
		} as unknown as HandlerCtx;
		const msg = { plan: [{ group_no: 1, slot_no: 1, code: 'A001' }] };

		return {
			run: () => liveHandlers(h).generateLiveGrid(msg, h),
			settings,
			prefs,
			confirmedDirs,
			actionLabels,
			statuses,
			get selectCount() {
				return selectCount;
			},
			// 每一条退出路径都必须发终态，否则前端按钮会永远卡在「生成中」
			terminalPhase: () => statuses.filter((m) => m?.type === 'liveGridStatus')
				.map((m) => m.phase)
				.filter((p) => p === 'done' || p === 'error' || p === 'cancelled')
				.pop(),
		};
	}

	teardown(() => {
		for (const root of roots.splice(0)) {
			removeTempDir(root);
		}
	});

	// 规矩：有得确认就只确认，没得确认才直接要目录，两者绝不叠加 → 屏幕上永远只有 1 个框。
	test('已设过有效目录：只弹 1 次确认框，不再弹目录选择器', async function () {
		this.timeout(15000);
		const dir = makeDir('saved');
		const harness = createHarness({ savedDir: dir, actions: ['确定生成'] });

		await harness.run();

		assert.strictEqual(harness.selectCount, 0);
		assert.deepStrictEqual(harness.confirmedDirs, [dir]);
		assert.deepStrictEqual(harness.actionLabels, [[
			'确定生成',
			'更换目录',
			'取消',
		]]);
		assert.strictEqual(harness.terminalPhase(), 'done');
	});

	// 模态框是排队显示的：一次点击进来两条 generateLiveGrid，第二条会等第一条关掉再弹，
	// 用户看到的就是「我点了确定，怎么又弹了一个」。后到的必须被直接忽略。
	test('重复投递：只认第一条，后来的不再弹框', async function () {
		this.timeout(15000);
		const dir = makeDir('dup');
		let release: (value: string) => void = () => undefined;
		const actionLabels: string[][] = [];
		const logs: string[] = [];
		const h = {
			ctx: {
				selectFolder: async () => undefined,
				chooseAction: async (_m: string, _d: string, labels: string[]) => {
					actionLabels.push(labels);
					// 卡在这里模拟「用户正盯着这个框」，第二条消息就在这段时间里到
					return new Promise<string>((resolve) => {
						release = resolve;
					});
				},
			} as unknown as ToolContext,
			db: {
				replaceLivePlan: () => undefined,
				getProducts: () => [{ code: 'A001' }],
			},
			getSetting: (key: string) => (key === 'live_out_dir' ? dir : ''),
			setSetting: async () => undefined,
			readOnly: () => false,
			imageDir: () => '',
			log: (text: string) => logs.push(text),
			post: () => undefined,
			postLiveState: () => undefined,
		} as unknown as HandlerCtx;
		const msg = { plan: [{ group_no: 1, slot_no: 1, code: 'A001' }] };

		const first = liveHandlers(h).generateLiveGrid(msg, h);
		for (let i = 0; i < 200 && actionLabels.length === 0; i += 1) {
			await new Promise((r) => setTimeout(r, 5));
		}
		assert.strictEqual(actionLabels.length, 1, '第一条消息应当弹出确认框');
		await liveHandlers(h).generateLiveGrid(msg, h);
		release('确定生成');
		await first;

		assert.strictEqual(actionLabels.length, 1, '第二条消息不得再弹框');
		assert.ok(
			logs.some((t) => t.includes('已有一个九宫格任务在跑')),
			`应当有一条说明为什么被忽略，实际日志：${logs.join(' | ')}`,
		);
	});

	test('确认框里按取消：一次就退出，不生成', async function () {
		this.timeout(15000);
		const dir = makeDir('saved');
		const harness = createHarness({ savedDir: dir, actions: ['取消'] });

		await harness.run();

		assert.strictEqual(harness.selectCount, 0);
		assert.strictEqual(harness.terminalPhase(), 'cancelled');
	});

	test('点「更换目录」：选完直接出图，不再回头确认', async function () {
		this.timeout(15000);
		const savedDir = makeDir('saved');
		const nextDir = makeDir('next');
		const harness = createHarness({
			savedDir,
			pickDirs: [nextDir],
			actions: ['更换目录'],
		});

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.deepStrictEqual(harness.actionLabels, [[
			'确定生成',
			'更换目录',
			'取消',
		]]);
		assert.strictEqual(harness.prefs.get('live_out_dir'), nextDir);
		assert.strictEqual(harness.terminalPhase(), 'done');
	});

	test('没设过目录：直接弹 1 次选择器，不弹确认框', async function () {
		this.timeout(15000);
		const dir = makeDir('first');
		const harness = createHarness({ pickDirs: [dir] });

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.deepStrictEqual(harness.actionLabels, []);
		assert.strictEqual(harness.prefs.get('live_out_dir'), dir);
		assert.strictEqual(harness.terminalPhase(), 'done');
	});

	test('在选择器里按取消：不生成，也不记目录', async function () {
		this.timeout(15000);
		const harness = createHarness({ pickDirs: [undefined] });

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.strictEqual(harness.terminalPhase(), 'cancelled');
		assert.strictEqual(harness.prefs.has('live_out_dir'), false);
	});

	// 目录被删掉 / 共享盘没挂载时 fs.statSync 会抛或返回 false，同样只弹 1 次选择器求新目录
	test('原目录已删除：重新选一次，不叠加确认框', async function () {
		this.timeout(15000);
		const removedDir = makeDir('removed');
		fs.rmSync(removedDir, { recursive: true });
		const nextDir = makeDir('next');
		const harness = createHarness({
			savedDir: removedDir,
			pickDirs: [nextDir],
		});

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.deepStrictEqual(harness.actionLabels, []);
		assert.strictEqual(harness.prefs.get('live_out_dir'), nextDir);
		assert.strictEqual(harness.terminalPhase(), 'done');
	});

	// 共享盘上「全组一份、最后改的人覆盖所有人」就是这么来的：
	// 输出目录是别人机器上的路径，存进 settings 表就等于把它推给全组。
	test('输出目录只写本机，绝不写共享库', async function () {
		this.timeout(15000);
		const dir = makeDir('local-only');
		const harness = createHarness({ pickDirs: [dir] });

		await harness.run();

		assert.strictEqual(harness.prefs.get('live_out_dir'), dir);
		assert.strictEqual(harness.settings.has('live_out_dir'), false);
	});

	test('只读模式下不落库（排品不写共享库，出图流程照走）', async function () {
		this.timeout(15000);
		const dir = makeDir('ro');
		let replaceLivePlanCalls = 0;
		const statuses: any[] = [];
		const h = {
			ctx: {
				selectFolder: async () => undefined,
				chooseAction: async () => '取消',
			} as unknown as ToolContext,
			db: {
				replaceLivePlan: () => {
					replaceLivePlanCalls += 1;
				},
				getProducts: () => [{ code: 'A001' }],
			},
			getSetting: (key: string) => (key === 'live_out_dir' ? dir : ''),
			setSetting: async () => undefined,
			readOnly: () => true,
			imageDir: () => '',
			log: () => undefined,
			post: (message: any) => statuses.push(message),
			postLiveState: () => undefined,
		} as unknown as HandlerCtx;

		await liveHandlers(h).generateLiveGrid(
			{ plan: [{ group_no: 1, slot_no: 1, code: 'A001' }] },
			h,
		);

		assert.strictEqual(replaceLivePlanCalls, 0);
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
			setSetting: async () => undefined,
			imageDir: () => dir,
			post: (message: any) => messages.push(message),
			log: () => undefined,
		} as unknown as HandlerCtx;

		await liveHandlers(h).generateStarOverview({}, h);

		assert.deepStrictEqual(messages, [{ type: 'starOverviewCancelled' }]);
	});
});

suite('设置项：共享业务规则 vs 个人偏好', () => {
	function createHarness() {
		const settings = new Map<string, string>();
		const prefs = new Map<string, unknown>();
		const logs: string[] = [];
		const posts: any[] = [];
		let loadAllCount = 0;
		let localPrefsCount = 0;
		const h = {
			ctx: { prefs: { get: (k: string, d: unknown) => prefs.get(k) ?? d, update: async (k: string, v: unknown) => { prefs.set(k, v); } } } as unknown as ToolContext,
			db: {
				clearAggCache: () => undefined,
				setSetting: (key: string, value: string) => {
					settings.set(key, value);
				},
			},
			getSetting: (key: string) => (LOCAL_PREF_KEYS.has(key) ? String(prefs.get(key) ?? '') : settings.get(key) ?? ''),
			setSetting: async (key: string, value: string) => {
				(LOCAL_PREF_KEYS.has(key) ? prefs : settings).set(key, value);
			},
			localPrefKey: (key: string) => LOCAL_PREF_KEYS.has(key),
			readOnly: () => prefs.get('readOnly') === true,
			log: (s: string) => logs.push(s),
			post: (m: any) => posts.push(m),
			loadAll: () => {
				loadAllCount += 1;
			},
			postLocalPrefs: () => {
				localPrefsCount += 1;
			},
		} as unknown as HandlerCtx;
		return {
			h,
			settings,
			prefs,
			logs,
			posts,
			get loadAllCount() { return loadAllCount; },
			get localPrefsCount() { return localPrefsCount; },
		};
	}

	test('个人偏好写本机，且不触发整库重载', async () => {
		const harness = createHarness();

		await settingsHandlers(harness.h).saveSettings({ key: 'font_size', value: '18' }, harness.h);

		assert.strictEqual(harness.prefs.get('font_size'), '18');
		assert.strictEqual(harness.settings.has('font_size'), false);
		// 改个字号就在共享盘上把整库重载一遍，是白等几十次网络往返
		assert.strictEqual(harness.loadAllCount, 0);
		assert.strictEqual(harness.localPrefsCount, 1);
	});

	test('共享业务规则写库并触发重载', async () => {
		const harness = createHarness();

		await settingsHandlers(harness.h).saveSettings({ key: 'stock_alert', value: '5' }, harness.h);

		assert.strictEqual(harness.settings.get('stock_alert'), '5');
		assert.strictEqual(harness.prefs.has('stock_alert'), false);
		assert.strictEqual(harness.loadAllCount, 1);
	});

	test('image_dir 仍被拒（历史遗留：收下就等于写回共享库）', async () => {
		const harness = createHarness();

		await settingsHandlers(harness.h).saveSettings({ key: 'image_dir', value: 'Z:\\图' }, harness.h);

		assert.strictEqual(harness.settings.has('image_dir'), false);
		assert.strictEqual(harness.prefs.has('image_dir'), false);
		assert.ok(harness.logs.some((l) => l.includes('不支持的设置项')));
	});

	test('只读开关写本机并回推前端', async () => {
		const harness = createHarness();

		await settingsHandlers(harness.h).setReadOnly({ value: true }, harness.h);

		assert.strictEqual(harness.prefs.get('readOnly'), true);
		assert.deepStrictEqual(harness.posts, [{ type: 'readOnlyChanged', readOnly: true }]);
		assert.strictEqual(harness.settings.has('readOnly'), false);
	});

	test('刷新先清汇总缓存再重载（否则累计售出停在面板打开那一刻）', async () => {
		const harness = createHarness();
		let cleared = 0;
		(harness.h as any).db.clearAggCache = () => {
			cleared += 1;
		};

		await settingsHandlers(harness.h).loadAll({}, harness.h);

		assert.strictEqual(cleared, 1);
		assert.strictEqual(harness.loadAllCount, 1);
	});
});

suite('商品图片删除（占用重试 / 不做无谓备份）', () => {
	const roots: string[] = [];


	// 1x1 红点 PNG，够 sharp 读，够判「第一张图是谁」
	const PNG_1PX = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64',
	);

	function makeRoot(): string {
		const root = makeTempDir('img-');
		roots.push(root);
		return root;
	}

	/**
	 * 显式钉死文件的 mtime。同一次 writeFileSync 连写几张，mtime 很可能落在同一毫秒上，
	 * 那时 listImageFiles 会走「同值回落文件名」那条分支，要测的「按加入时间排」根本测不出来。
	 */
	function stampFile(fp: string, iso: string): void {
		const t = new Date(iso);
		fs.utimesSync(fp, t, t);
	}

	/** 造一个可用的图片根目录 + 一个装了 1 张图的编号夹 */
	function seed(code = 'L001'): { root: string; folder: string } {
		const root = makeRoot();
		const folder = path.join(root, code);
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, 'b.png'), PNG_1PX);
		return { root, folder };
	}

	function createHarness(imageRoot: string) {
		const storage = makeRoot();
		const posted: any[] = [];
		const logs: string[] = [];
		const coverCache = new Map<string, { data: string; dirMtime: number }>();
		let backupCount = 0;
		let loadAllCount = 0;
		const ctx = {
			defaultStorageDir: storage,
			// 宿主那一层：handler 现在只认 ctx.imageUrl / revealInOS / pickStorageDir
			imageUrl: (fp: string) => `file:///${String(fp).replace(/\\/g, "/")}`,
			revealInOS: async () => undefined,
			pickStorageDir: async () => undefined,
		} as unknown as ToolContext;
		const h = {
			ctx,
			imageDir: () => imageRoot,
			coverCache,
			log: (s: string) => logs.push(s),
			post: (m: any) => posted.push(m),
			preOpBackup: async () => {
				backupCount += 1;
			},
			invalidateCover: (code: string) => coverCache.delete(code),
			loadAll: () => {
				loadAllCount += 1;
			},
		} as unknown as HandlerCtx;

		return {
			h,
			posted,
			logs,
			coverCache,
			get backupCount() {
				return backupCount;
			},
			get loadAllCount() {
				return loadAllCount;
			},
		};
	}

	/**
	 * 造一个「前 times 次占用、之后放行」的 unlink 实现。
	 * 走 imageHandlers 的依赖注入而非 patch fs：fs 是 ESM namespace，赋值会抛 read-only。
	 */
	function failUnlink(times: number, code: string): (fp: string) => void {
		let left = times;
		return (fp: string) => {
			if (left > 0) {
				left -= 1;
				const err: NodeJS.ErrnoException = new Error(`mock ${code}: ${fp}`);
				err.code = code;
				throw err;
			}
			fs.unlinkSync(fp);
		};
	}

	teardown(() => {
		for (const root of roots.splice(0)) {
			removeTempDir(root);
		}
	});

	test('封面缓存按图片夹 mtime 判活：夹没被动就复用，动过就重取', async () => {
		const { root, folder } = seed();
		const harness = createHarness(root);
		const handlers = imageHandlers(harness.h);

		await handlers.getCover({ code: 'L001' }, harness.h);
		const first = harness.coverCache.get('L001');
		assert.ok(first, '第一次应当读盘并写入缓存');
		assert.ok(first.data.startsWith('data:image/webp'), `应产出 webp 缩略图，实际 ${first.data.slice(0, 30)}`);

		// 夹没被动：直接复用同一个缓存对象，不重新读盘
		await handlers.getCover({ code: 'L001' }, harness.h);
		assert.strictEqual(harness.coverCache.get('L001'), first, '图片夹没变就不该重取');

		// 别人往夹里放了图 → 目录 mtime 变 → 必须重取（这正是 0.0.13 刷不出来的那个 bug）
		fs.writeFileSync(path.join(folder, 'a.png'), PNG_1PX);
		await handlers.getCover({ code: 'L001' }, harness.h);
		assert.notStrictEqual(harness.coverCache.get('L001'), first, '图片夹被动过就该重取封面');
	});

	test('别人把整个图片夹删了：刷新得到空图而不是旧缓存', async () => {
		const { root, folder } = seed();
		const harness = createHarness(root);
		const handlers = imageHandlers(harness.h);

		await handlers.getCover({ code: 'L001' }, harness.h);
		assert.ok(harness.coverCache.get('L001')?.data);

		fs.rmSync(folder, { recursive: true, force: true });
		await handlers.getCover({ code: 'L001' }, harness.h);

		assert.strictEqual(harness.coverCache.get('L001')?.data, '', '夹没了就该是空图');
	});

	test('删图不触发数据库备份（不改库，备份出来跟操作前一模一样）', async () => {
		const { root, folder } = seed();
		const harness = createHarness(root);

		await imageHandlers(harness.h).deleteImageFile({ code: 'L001', index: 0 }, harness.h);

		assert.strictEqual(harness.backupCount, 0, '删图只动文件系统，不该拷整库');
		assert.strictEqual(fs.existsSync(path.join(folder, 'b.png')), false);
		assert.ok(harness.logs.some((l) => l.includes('已删除 L001 的第 1 张')));
	});

	test('清空图片夹不触发数据库备份', async () => {
		const { root, folder } = seed();
		fs.writeFileSync(path.join(folder, 'a.png'), PNG_1PX);
		const harness = createHarness(root);

		await imageHandlers(harness.h).clearImages({ code: 'L001' }, harness.h);

		assert.strictEqual(harness.backupCount, 0);
		assert.deepStrictEqual(fs.readdirSync(folder), []);
	});

	// 下面四条会真的走完 0/150/400/1000ms 的退避序列，光是等就要 1550ms，再加上建
	// 临时目录、抽封面这些杂活，本机实测跑到 1.6~1.8s —— 已经贴着 mocha 默认的
	// 2000ms 了。前面刚跑完 compile/lint、或者赶上杀软扫盘，就会随机变红。显式放宽。
	test('文件被占用时会退避重试，重试成功即算删掉', async function () {
		this.timeout(15000);
		const { root, folder } = seed();
		const harness = createHarness(root);
		// 前两次 EBUSY（杀软扫描/句柄未回收这类瞬时占用），第三次放行
		await imageHandlers(harness.h, { unlink: failUnlink(2, 'EBUSY') }).deleteImageFile(
			{ code: 'L001', index: 0 },
			harness.h,
		);

		assert.strictEqual(fs.existsSync(path.join(folder, 'b.png')), false, '重试成功后应真的删掉');
		assert.ok(harness.logs.some((l) => l.includes('已删除')));
		assert.ok(!harness.logs.some((l) => l.includes('删不掉')), '不该报错');
	});

	test('重试到底仍被占用：说清是占用，并把磁盘现状推回前端', async function () {
		this.timeout(15000);
		const { root, folder } = seed();
		const harness = createHarness(root);
		// 次数给足，覆盖全部 4 次尝试
		await imageHandlers(harness.h, { unlink: failUnlink(99, 'EBUSY') }).deleteImageFile(
			{ code: 'L001', index: 0 },
			harness.h,
		);

		assert.strictEqual(fs.existsSync(path.join(folder, 'b.png')), true, '删不掉就该还在');
		const said = harness.logs.find((l) => l.includes('删不掉'));
		assert.ok(said, `应给出提示，实际日志：${JSON.stringify(harness.logs)}`);
		assert.ok(said!.includes('正被占用'), '提示要说人话，不要只甩 EBUSY');
		// 前端状态必须跟磁盘一致，否则用户不知道到底删没删
		assert.ok(
			harness.posted.some((m) => m.type === 'imagesLoaded'),
			'删失败也要 reloadImages，否则列表停在「还在」',
		);
		// 删图不改商品表：不该再整库重读重推（封面作废有 coverInvalidated 单条通道）
		assert.strictEqual(harness.loadAllCount, 0, '删图是纯文件操作，不该重载整表');
	});

	test('非占用类错误不重试，直接报原始信息', async function () {
		this.timeout(15000);
		const { root } = seed();
		const harness = createHarness(root);
		await imageHandlers(harness.h, { unlink: failUnlink(99, 'ENOENT') }).deleteImageFile(
			{ code: 'L001', index: 0 },
			harness.h,
		);

		const said = harness.logs.find((l) => l.includes('删不掉'));
		assert.ok(said, '应报错');
		assert.ok(!said!.includes('正被占用'), 'ENOENT 不是占用，别误导用户去关预览');
	});

	// 列表/画册右键封面走的是 deleteCoverImage（不经过灯箱、不收 name/index）。
	// 它必须删掉「当前当封面那张」——夹里按加入时间排的第一张，而不是文件名排第一的那张。
	test('删封面图：只删当前当封面那张，下一张自动顶上来', async function () {
		this.timeout(15000);
		const { root, folder } = seed(); // 已有 b.png（没 stamp，mtime=现在）
		const harness = createHarness(root);
		// 加一张加入时间更早、但文件名排在 b 之后的图：封面按加入时间取，所以封面是
		// zz_early.png。这样能证明「删的是封面（最早加入）」，而不是「按文件名删第一个」。
		fs.writeFileSync(path.join(folder, 'zz_early.png'), PNG_1PX);
		stampFile(path.join(folder, 'zz_early.png'), '2020-01-01T00:00:00Z');
		stampFile(path.join(folder, 'b.png'), '2021-01-01T00:00:00Z');

		await imageHandlers(harness.h).deleteCoverImage({ code: 'L001' }, harness.h);

		assert.strictEqual(
			fs.existsSync(path.join(folder, 'zz_early.png')),
			false,
			'当前当封面那张（最早加入的 zz_early.png）应被删掉',
		);
		assert.strictEqual(
			fs.existsSync(path.join(folder, 'b.png')),
			true,
			'只删封面一张，其余留在夹里',
		);
		assert.ok(harness.logs.some((l) => l.includes('已删除')), '应报告已删除');
		assert.ok(!harness.logs.some((l) => l.includes('删不掉')), '不该报错');
		// 跟 deleteImageFile 一样：删图是纯文件操作，不重载整表；封面作废走 coverInvalidated
		assert.strictEqual(harness.loadAllCount, 0, '删封面不该重载整表');
		assert.ok(
			harness.posted.some((m) => m.type === 'imagesLoaded'),
			'删完要 reloadImages，让列表/画册立刻反映磁盘现状',
		);
	});

	test('删封面图：夹里本来就没图时不报错、不硬删', async function () {
		this.timeout(15000);
		const { root, folder } = seed();
		const harness = createHarness(root);
		fs.unlinkSync(path.join(folder, 'b.png')); // 夹空了

		await imageHandlers(harness.h).deleteCoverImage({ code: 'L001' }, harness.h);

		assert.ok(
			!harness.logs.some((l) => l.includes('删不掉') && !l.includes('本来就没有')),
			'空夹不该报「删不掉」，实际：' + JSON.stringify(harness.logs),
		);
		assert.strictEqual(harness.backupCount, 0, '删图不写库，不该备份');
	});

	test('清空图片夹：部分删不掉时报实际张数，不谎报「已清空」', async function () {
		this.timeout(15000);
		const { root, folder } = seed();
		fs.writeFileSync(path.join(folder, 'a.png'), PNG_1PX);
		const harness = createHarness(root);
		// 让第二次起的删除都失败：先删掉 b.png 成功，之后全部 EBUSY
		let n = 0;
		const flaky: (fp: string) => void = (fp) => {
			n += 1;
			if (n > 1) {
				const err: NodeJS.ErrnoException = new Error('mock EBUSY');
				err.code = 'EBUSY';
				throw err;
			}
			fs.unlinkSync(fp);
		};

		await imageHandlers(harness.h, { unlink: flaky }).clearImages({ code: 'L001' }, harness.h);

		assert.ok(
			!harness.logs.some((l) => l.includes('已清空')),
			`有张数没删掉就不许说「已清空」，实际：${JSON.stringify(harness.logs)}`,
		);
		const said = harness.logs.find((l) => l.includes('正被占用'));
		assert.ok(said, '应说明是被占用');
		assert.ok(said!.includes('1/2'), `应报出实际删了几张，实际：${said}`);
		assert.strictEqual(fs.readdirSync(folder).length, 1, '剩下一张还在');
	});

	// —— 批量清空图片（clearImagesBatch）——
	// 刻意不走「webview 连发 N 条 clearImages」那条路：每条都要重读整张商品表，
	// 勾 50 个就是 50 趟全库。现在连那一次也不需要了：清图是纯文件操作，商品表一个字
	// 没改，封面作废走 coverInvalidated（图库更新走 imagesLoaded）。
	// 下面第一条把「0 次整表重载」钉住，防有人以后又顺手加回去。

	test('批量清空：逐个清、整表一次都不重载、逐个推 imagesLoaded', async () => {
		const { root } = seed();
		const folder2 = path.join(root, 'L002');
		fs.mkdirSync(folder2);
		fs.writeFileSync(path.join(folder2, 'a.png'), PNG_1PX);
		fs.writeFileSync(path.join(folder2, 'b.png'), PNG_1PX);
		const harness = createHarness(root);

		await imageHandlers(harness.h).clearImagesBatch({ codes: ['L001', 'L002'] }, harness.h);

		assert.deepStrictEqual(fs.readdirSync(path.join(root, 'L001')), []);
		assert.deepStrictEqual(fs.readdirSync(folder2), []);
		assert.strictEqual(harness.loadAllCount, 0, '清图不改库：N 个夹一个都不该重载整表');
		// 灯箱按 code 认领，imagesLoaded 必须一个 code 一条，合并成一条它不知道该刷哪格
		const pushed = harness.posted.filter((m) => m.type === 'imagesLoaded').map((m) => m.code);
		assert.deepStrictEqual(pushed, ['L001', 'L002']);
		assert.strictEqual(harness.backupCount, 0, '清图是纯文件操作，不该拷整库');
		const said = harness.logs.find((l) => l.includes('已清空'));
		assert.ok(said, '应报已清空');
		assert.ok(said!.includes('2 个商品'), `应报清了几个，实际：${said}`);
	});

	test('批量清空：没删干净的单独报，绝不混进「已清空」', async function () {
		this.timeout(15000);
		const { root, folder } = seed();
		const folder2 = path.join(root, 'L002');
		fs.mkdirSync(folder2);
		fs.writeFileSync(path.join(folder2, 'a.png'), PNG_1PX);
		const harness = createHarness(root);
		// L002 那张删不动（模拟另一台机器正开着），L001 照常清掉
		const blocked = path.join(folder2, 'a.png');
		const unlink = (fp: string) => {
			if (fp === blocked) {
				const err: NodeJS.ErrnoException = new Error('mock EBUSY');
				err.code = 'EBUSY';
				throw err;
			}
			fs.unlinkSync(fp);
		};

		await imageHandlers(harness.h, { unlink }).clearImagesBatch(
			{ codes: ['L001', 'L002'] },
			harness.h,
		);

		// 汇总是一条多行日志，断言要按行拆开看：
		// 「已清空」那一行里绝不能出现 L002，否则用户会以为两个都清干净了。
		const lines = harness.logs.join('\n').split('\n');
		const cleared = lines.find((l) => l.includes('已清空'));
		assert.ok(cleared, 'L001 应报已清空');
		assert.ok(cleared!.includes('L001'), `实际：${cleared}`);
		assert.ok(!cleared!.includes('L002'), `没删干净的不许混进「已清空」，实际：${cleared}`);
		const stuck = lines.find((l) => l.includes('没清干净'));
		assert.ok(stuck, '应单独说哪些没清干净');
		assert.ok(stuck!.includes('L002（只删掉 0/1 张）'), `应报出实际删了几张，实际：${stuck}`);
		assert.ok(
			harness.logs.join('\n').includes('正被占用'),
			'应说明是被占用（附 busyHint 的排查提示）',
		);
		assert.deepStrictEqual(fs.readdirSync(folder), [], 'L001 照样应该清掉了');
		assert.deepStrictEqual(fs.readdirSync(folder2), ['a.png'], 'L002 的文件应该还在');
	});

	test('批量清空：编号带路径分隔符的会被跳过，图片根目录之外的东西不会被删', async () => {
		const root = makeRoot();
		const folder = path.join(root, 'L001');
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, 'a.png'), PNG_1PX);
		// 攻击目标是 root 的**兄弟**目录：`../<basename>` 拼进去刚好指到它
		const evil = path.join(root, '..', `${path.basename(root)}-evil`);
		fs.mkdirSync(evil, { recursive: true });
		roots.push(evil);
		fs.writeFileSync(path.join(evil, 'secret.png'), PNG_1PX);
		const harness = createHarness(root);

		await imageHandlers(harness.h).clearImagesBatch(
			{ codes: ['..', `../${path.basename(root)}-evil`, 'L001'] },
			harness.h,
		);

		assert.deepStrictEqual(fs.readdirSync(evil), ['secret.png'], '根目录外的文件不该被删');
		assert.deepStrictEqual(fs.readdirSync(folder), [], '合法的编号照常清');
		assert.ok(harness.logs.some((l) => l.includes('编号不合法')), '应说清跳过了几个');
	});

	test('防回归：改库操作仍必须留档，只有纯文件操作被摘出去', () => {
		// out/test/ → out/ → 仓库根，再进 src/tools/...（编译产物只拷 .js，源码得从 src 找）
		const repoSrc = path.join(__dirname, '..', '..', 'src', 'tools', 'shopTool', 'handlers');
		const read = (f: string) => fs.readFileSync(path.join(repoSrc, f), 'utf-8');

		// 删图/清图是纯文件操作，不该再有真实调用（只匹配调用，注释里提到不算）
		assert.ok(
			!/await\s+h\.preOpBackup\(\)/.test(read('image.ts')),
			'image.ts 里不该再有 h.preOpBackup() 调用（删图不改库，备份零信息量还要白等 4 秒）',
		);
		// 真正改库的域，一个都不能少
		for (const f of ['product.ts', 'sales.ts', 'settle.ts', 'impexp.ts']) {
			assert.ok(
				/await\s+h\.preOpBackup\(\)/.test(read(f)),
				`${f} 改库，必须保留 h.preOpBackup()`,
			);
		}

		// 导入是唯一的例外，且是**刻意**的例外：它下面的 h.snapshot() 抓的是同一份「导入前」
		// 状态、已经进了撤销栈，留档只是把同一份数据再整库拷一遍共享盘 + 本机。
		// 导入是 preOpBackup 唯一的日常高频调用点，不砍它就等于每次导入都得等两次整库拷贝。
		// 这条断言的作用是把这个决定钉住，别让以后有人顺手加回来。
		const productSrc = read('product.ts');
		// 源码是 CRLF，行尾不能写死 \n，否则这条断言会因为换行风格而假失败
		const importBody = /async commitImportProducts\(msg\) \{([\s\S]*?)\r?\n {4}\},\r?\n/.exec(
			productSrc,
		);
		assert.ok(importBody, '应能定位到 commitImportProducts 函数体');
		assert.ok(
			importBody![1].includes('preOpBackup'),
			'导入处应留注释说明为什么不留档，否则后人看不懂为什么唯独它特殊',
		);
		// 只匹配真实调用，注释里提到不算（同上面对 image.ts 的处理）
		assert.ok(
			!/h\.preOpBackup\(/.test(importBody![1]),
			'commitImportProducts 不该再 h.preOpBackup()（撤销栈 + 每日自动备份已兜底）',
		);
		assert.ok(
			/h\.snapshot\(\)/.test(importBody![1]),
			'commitImportProducts 必须仍然抓 h.snapshot()，否则撤销就没了',
		);
	});

	test('留档不能拖死操作：卡死的备份到点就放弃，且不抛错', async () => {
		// 共享盘断连时 backupDB 可能永远不 resolve（要等 SMB 超时）。
		// 到点必须返回「超时放弃」，而不是让调用方的删除/导入整段卡住、或抛出未捕获异常。
		const started = Date.now();
		let released = false;
		const timedOut = await withBackupTimeout(
			() => new Promise<void>(() => {}), // 永不落地
			120,
		);
		assert.strictEqual(timedOut, true, '卡死的留档应报超时');
		assert.ok(Date.now() - started < 3000, '应在时限内返回，而不是等满 SMB 超时');
		assert.strictEqual(released, false);

		// 正常完成的留档：不算超时
		let ran = false;
		const ok = await withBackupTimeout(async () => {
			ran = true;
		}, 1000);
		assert.strictEqual(ok, false, '正常完成不该算超时');
		assert.strictEqual(ran, true);

		// work 内部抛错：必须被吞掉（否则变成 unhandledRejection 掀掉扩展宿主），
		// 但仍按「时限内跑完」返回，失败由 work 自己记日志。
		const swallowed = await withBackupTimeout(async () => {
			throw new Error('盘写满了');
		}, 1000);
		assert.strictEqual(swallowed, false, 'work 抛错不等于超时');
	});

	test('留档必须先写 .tmp 再改名：半截文件不能顶着 .db 冒充备份', () => {
		const src = fs.readFileSync(
			path.join(__dirname, '..', '..', 'src', 'tools', 'shopTool', 'index.ts'),
			'utf-8',
		);
		// 超时/断连放弃的留档当场可能删不掉（Windows 上 SQLite 开着文件时 unlink 会 EBUSY）。
		// 先写 .tmp、成功才改名，半截文件就永远不会被 .db 配额算进去、
		// 也不会被 importDB 的选文件框误选成一份「备份」。
		assert.ok(
			/backupDB\(tmp\)[\s\S]*?renameSync\(tmp, file\)/.test(src),
			'backupToDir 应先 backupDB(tmp)、再 renameSync(tmp, file)',
		);
		assert.ok(
			/const tmp = `\$\{file\}\$\{BACKUP_TMP_SUFFIX\}`/.test(src),
			'tmp 名应基于正式文件名加 .tmp 后缀',
		);
		// 超时上限必须真的在 preOpBackup / maybeAutoBackup 两条路径上都套上了：
		// 后者在面板启动路径上（index.ts 里是 await 的），断连时会把整个面板初始化卡住。
		assert.ok(
			/pruneStaleBackupTmps/.test(src),
			'应有残留 .tmp 的按天回收',
		);
		const guardCalls = (src.match(/withBackupTimeout\(/g) || []).length;
		// 1 次定义 + preOpBackup 1 次 + maybeAutoBackup 1 次
		assert.strictEqual(guardCalls, 3, 'preOpBackup 与 maybeAutoBackup 都应套上超时上限');
	});

	test('删不掉时日志要能自证：改名探针 + 三类占用者 + 两条可粘命令', async function () {
		this.timeout(15000);
		const { root, folder } = seed();
		const harness = createHarness(root);
		await imageHandlers(harness.h, { unlink: failUnlink(99, 'EBUSY') }).deleteImageFile(
			{ code: 'L001', index: 0 },
			harness.h,
		);

		const said = harness.logs.find((l) => l.includes('删不掉'))!;
		// 探针结论：这里的 EBUSY 是注入的假占用，磁盘上并没有人真的开着它，
		// 所以改名探针（真 fs.renameSync）应当成功 → 日志要敢下这个结论
		assert.ok(said.includes('自证'), `应给出探针结论，实际：${said}`);
		assert.ok(
			said.includes('改名探针**成功**了'),
			`没锁时不该说成锁，实际：${said}`,
		);
		// 三类占用者 + 两条命令，一样都不能少（用户照着就能自己查）
		assert.ok(said.includes('三类占用者'), `应列出最可能的占用者，实际：${said}`);
		assert.ok(said.includes('handle.exe'), '应给出本机查占用者的命令');
		assert.ok(said.includes('Get-SmbOpenFile'), '应给出共享提供方那台机器查会话的命令');
		assert.ok(said.includes('b.png'), '命令里要带上真实文件名，否则没法照抄');
		// 探针把文件改名又改回来了，磁盘现状不能被它弄乱
		assert.deepStrictEqual(fs.readdirSync(folder), ['b.png']);
	});

	test('删图会先等后台缩略图：星标总览留在后台的那个读，跑完再删就删得掉', async function () {
		this.timeout(15000);
		const { root, folder } = seed();
		const harness = createHarness(root);
		const fp = path.join(folder, 'b.png');
		// 星标总览预览走的就是这条：build=false 立刻返回 null，缩图丢到后台读原图。
			// 这条断言守着的就是「谁跑过星标总览谁就删不掉」那个坑。
		assert.strictEqual(
			await previewThumbPath(fp, path.join(root, 'cache'), 'L001'),
			null,
			'build=false 应立刻返回 null（第一次预览不等缩图）',
		);

		await imageHandlers(harness.h).deleteImageFile({ code: 'L001', index: 0 }, harness.h);

		assert.strictEqual(fs.existsSync(fp), false, '删图应成功');
		assert.ok(
			!harness.logs.some((l) => l.includes('删不掉')),
			`不该报占用，实际：${JSON.stringify(harness.logs)}`,
		);
	});
});

suite('图库按「加入文件夹的时间」排序（封面 = 最先放进去的那张）', () => {
	const roots: string[] = [];
	const PNG_1PX = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64',
	);

	function makeRoot(): string {
		const root = makeTempDir('img-sort-');
		roots.push(root);
		return root;
	}

	/** 钉死 mtime，否则同一次写入的几张很可能同毫秒，「按时间排」就测不出差别了 */
	function stampFile(fp: string, iso: string): void {
		const t = new Date(iso);
		fs.utimesSync(fp, t, t);
	}

	/** 造一个夹子并指定每张图的加入时间；名字按传入顺序摆（`{名字, 时间}`） */
	function seedImages(items: Array<[string, string]>): { root: string; folder: string } {
		const root = makeRoot();
		const folder = path.join(root, 'L001');
		fs.mkdirSync(folder);
		for (const [name, iso] of items) {
			const fp = path.join(folder, name);
			fs.writeFileSync(fp, PNG_1PX);
			stampFile(fp, iso);
		}
		return { root, folder };
	}

	test('字母序和时间序故意相反时，按加入时间排（不看文件名）', () => {
		const { folder } = seedImages([
			['zzz.png', '2026-01-01T00:00:00Z'], // 先放
			['aaa.png', '2026-06-01T00:00:00Z'], // 后放
		]);

		assert.deepStrictEqual(
			listImageFiles(folder),
			['zzz.png', 'aaa.png'],
			'应按 mtime 升序；按文件名排的话会给出 aaa 在前',
		);
	});

	test('加入时间完全相同时回落文件名，保证同一份夹子两次读顺序一致', () => {
		// 这条不是口味问题：deleteImageFile / getFullImage 都是在**请求到达时**重新读一次
		// 目录再按下标取文件，顺序不稳定就意味着删掉的不是用户看到的那张
		const { folder } = seedImages([
			['b.png', '2026-01-01T00:00:00Z'],
			['a.png', '2026-01-01T00:00:00Z'],
		]);

		const first = listImageFiles(folder);
		const second = listImageFiles(folder);

		assert.deepStrictEqual(first, ['a.png', 'b.png'], '同 mtime 应按文件名 a 在前');
		assert.deepStrictEqual(second, first, '两次读必须完全一致，否则按下标操作会指错文件');
	});

	test('封面是最先放进去的那张：与文件名字母序相反时也要选对', async () => {
		const { root, folder } = seedImages([
			['zzz.png', '2026-01-01T00:00:00Z'],
			['aaa.png', '2026-06-01T00:00:00Z'],
		]);
		const storage = makeRoot();
		const posted: any[] = [];
		const coverCache = new Map<string, { data: string; dirMtime: number }>();
		const h = {
			ctx: {
				defaultStorageDir: storage,
				// 宿主那一层：handler 现在只认 ctx.imageUrl / revealInOS / pickStorageDir，
				// 不再直接碰 panel.webview（那是 VS Code 宿主的事）
				imageUrl: (fp: string) => `file:///${String(fp).replace(/\\/g, "/")}`,
				revealInOS: async () => undefined,
				pickStorageDir: async () => undefined,
			} as unknown as ToolContext,
			imageDir: () => root,
			coverCache,
			log: () => undefined,
			post: (m: any) => posted.push(m),
			preOpBackup: async () => undefined,
			invalidateCover: (code: string) => coverCache.delete(code),
			loadAll: () => undefined,
		} as unknown as HandlerCtx;

		await imageHandlers(h).getCover({ code: 'L001' }, h);

		const want = await thumbToCachedBase64(
			path.join(folder, 'zzz.png'),
			storage,
			'L001',
			'zzz.png',
		);
		assert.ok(want, '对照用的缩略图本身应生成成功');
		assert.strictEqual(
			coverCache.get('L001')?.data,
			want,
			'封面应是 mtime 最早那张（zzz），不是字母序靠前的 aaa',
		);
	});

	test('imagesLoaded 的 names 与 images 严格同序（前端靠它把序号换算成身份）', async () => {
		const { root, folder } = seedImages([
			['zzz.png', '2026-01-01T00:00:00Z'],
			['aaa.png', '2026-06-01T00:00:00Z'],
		]);
		const storage = makeRoot();
		const posted: any[] = [];
		const h = {
			ctx: {
				defaultStorageDir: storage,
				// 宿主那一层：handler 现在只认 ctx.imageUrl / revealInOS / pickStorageDir，
				// 不再直接碰 panel.webview（那是 VS Code 宿主的事）
				imageUrl: (fp: string) => `file:///${String(fp).replace(/\\/g, "/")}`,
				revealInOS: async () => undefined,
				pickStorageDir: async () => undefined,
			} as unknown as ToolContext,
			imageDir: () => root,
			coverCache: new Map(),
			log: () => undefined,
			post: (m: any) => posted.push(m),
			preOpBackup: async () => undefined,
			invalidateCover: () => undefined,
			loadAll: () => undefined,
		} as unknown as HandlerCtx;

		await imageHandlers(h).getImages({ code: 'L001' }, h);

		const msg = posted.find((m) => m.type === 'imagesLoaded');
		assert.ok(msg, '应推送 imagesLoaded');
		assert.deepStrictEqual(msg.names, listImageFiles(folder));
		assert.strictEqual(msg.names.length, msg.images.length, 'names 与 images 必须一一对应');
	});

	test('删掉一张后，剩下那张仍能按自己的文件名取到原图（就是那个 bug 的后端不变量）', async () => {
		const { root, folder } = seedImages([
			['a.png', '2026-01-01T00:00:00Z'],
			['b.png', '2026-06-01T00:00:00Z'],
		]);
		const storage = makeRoot();
		const posted: any[] = [];
		const h = {
			ctx: {
				defaultStorageDir: storage,
				// 宿主那一层：handler 现在只认 ctx.imageUrl / revealInOS / pickStorageDir，
				// 不再直接碰 panel.webview（那是 VS Code 宿主的事）
				imageUrl: (fp: string) => `file:///${String(fp).replace(/\\/g, "/")}`,
				revealInOS: async () => undefined,
				pickStorageDir: async () => undefined,
			} as unknown as ToolContext,
			imageDir: () => root,
			coverCache: new Map(),
			log: () => undefined,
			post: (m: any) => posted.push(m),
			preOpBackup: async () => undefined,
			invalidateCover: () => undefined,
			loadAll: () => undefined,
		} as unknown as HandlerCtx;
		const handlers = imageHandlers(h);

		await handlers.deleteImageFile({ code: 'L001', index: 0, name: 'a.png' }, h);
		assert.strictEqual(fs.existsSync(path.join(folder, 'a.png')), false);
		const after = posted.filter((m) => m.type === 'imagesLoaded').pop();
		assert.deepStrictEqual(after.names, ['b.png'], 'b.png 现在排在序号 0');

		// 关键：序号已经是 0 了，但它的身份仍然是 b.png。前端如果还用序号当缓存键，
		// 这里就会命中「刚被删掉那张」的 base64 —— 大图停在已删除的图上
		posted.length = 0;
		await handlers.getFullImage({ code: 'L001', index: 0, name: 'b.png', base64: true }, h);
		const got = posted.find((m) => m.type === 'fullImageLoaded');
		assert.ok(got?.data, '按文件名应能取到 b.png 的原图');
		assert.strictEqual(got.name, 'b.png', '回复要回带 name，前端据此写缓存键');
	});

	test('大图请求里的文件名不老实：目录穿越拿不到任何内容，且不退回序号', async () => {
		const { root } = seedImages([['a.png', '2026-01-01T00:00:00Z']]);
		// 夹子外面放一张真图，用来验证真的没被读到
		fs.writeFileSync(path.join(root, 'secret.png'), PNG_1PX);
		const storage = makeRoot();
		const posted: any[] = [];
		const h = {
			ctx: {
				defaultStorageDir: storage,
				// 宿主那一层：handler 现在只认 ctx.imageUrl / revealInOS / pickStorageDir，
				// 不再直接碰 panel.webview（那是 VS Code 宿主的事）
				imageUrl: (fp: string) => `file:///${String(fp).replace(/\\/g, "/")}`,
				revealInOS: async () => undefined,
				pickStorageDir: async () => undefined,
			} as unknown as ToolContext,
			imageDir: () => root,
			coverCache: new Map(),
			log: () => undefined,
			post: (m: any) => posted.push(m),
			preOpBackup: async () => undefined,
			invalidateCover: () => undefined,
			loadAll: () => undefined,
		} as unknown as HandlerCtx;
		const handlers = imageHandlers(h);

		for (const bad of ['../secret.png', '..\\secret.png', 'a/b.png', '.', '..', '.hidden.png']) {
			posted.length = 0;
			await handlers.getFullImage({ code: 'L001', index: 0, name: bad, base64: true }, h);
			const got = posted.find((m) => m.type === 'fullImageLoaded');
			assert.ok(!got?.data, `${bad} 不该取到任何内容`);
			assert.ok(!got?.uri, `${bad} 不该给出一个 URI`);
		}
	});
});

suite('防回归：图库与灯箱的身份一律用文件名，不用序号', () => {
	function readClient(name: string): string {
		// out/test/ → out/ → 仓库根，再进 src/tools/...（编译产物只拷 .js，源码得从 src 找）
		return fs.readFileSync(
			path.join(__dirname, '..', '..', 'src', 'tools', 'shopTool', name),
			'utf-8',
		);
	}

	test('大图缓存键不许再用序号', () => {
		const src = readClient('client-main.js');
		// `${code}:${idx}` 形式的键一旦回来，删图后就又会出现「大图还是已删除那张、
		// 缩略图条排版却是对的」——因为删掉第 1 张会让后面所有张的序号前移
		assert.ok(
			!/\$\{(?:msg\.)?code\}:\$\{(?:msg\.)?idx\}/.test(src),
			'client-main.js 里不该再有 `${code}:${idx}` 形式的缓存键（必须按文件名）',
		);
		assert.ok(
			/state\.lbNames\s*=\s*msg\.names/.test(src),
			'灯箱应保存后端下发的 names（文件名清单）',
		);
		assert.ok(
			/\[data-ic-id="lbCopyImg"\]/.test(src),
			'enableLbCopyItem 应按 id 找复制项：菜单项已改成条件构造，「排在 data-ic=0」不再等价',
		);
		assert.ok(
			/data-ic-id="\$\{esc\(it\.id\)\}"/.test(readClient('client-core.js')),
			'showImageCtxMenu 渲染时没把 item.id 落到 data-ic-id，按 id 找就无从谈起',
		);
	});

	test('openLightbox 必须先 closeLightbox() 再赋 state.lbCode', () => {
		const src = readClient('client-product.js');
		// closeLightbox 会把 lbCode 清成 null。顺序反了（先赋值后 close）就等于
		// 每次开灯箱都把 code 自己抹掉，之后 imagesLoaded 全都对不上，灯箱永远空白。
		// 这处没有 DOM 可测，用源码断言钉住顺序
		const body = /function openLightbox\(product\) \{[\s\S]*?\n\}/.exec(src);
		assert.ok(body, '应能定位到 openLightbox 函数体');
		const at = body![0];
		assert.ok(at.includes('closeLightbox()'), 'openLightbox 内应有 closeLightbox() 调用');
		assert.ok(
			at.indexOf('closeLightbox()') < at.indexOf('state.lbCode = product.code'),
			'closeLightbox() 必须排在 `state.lbCode = product.code` 之前（反过来会被自己抹掉）',
		);
		assert.ok(
			/function closeLightbox\(\) \{[\s\S]*?state\.lbCode = null;[\s\S]*?\n\}/.test(src),
			'closeLightbox 应把 state.lbCode 清成 null（否则陈旧 code 会漏给拖放/粘贴的落点解析）',
		);
	});

	test('星标总览关掉再开必须回到 3×3（不读已摘除弹窗里的旧排版）', () => {
		const src = readClient('client-product.js');
		// 这个 bug 是从「还是会记住」里挖出来的：closeModal() 只 remove() 节点，starOv.mask
		// 仍指着已摘除的子树，如果 starOvDims 只看 `!starOv.mask`，重新打开时就会在旧 select
		// 上读出上次选的值（4×3 / custom / 自动…），把上次排版原样送回去。isConnected 这半句
		// 把它定义成「不在文档里＝没开」，和 starOvRequestPreview 的开窗判断是同一个口径。
		const body = /function starOvDims\(\) \{[\s\S]*?\n\}/.exec(src);
		assert.ok(body, '应能定位到 starOvDims 函数体');
		const at = body![0];
		assert.ok(
			at.includes('!starOv.mask.isConnected'),
			'starOvDims 应把「已摘除的 mask」当作没开：否则关了弹窗再开，会把旧 select 上的排版带回',
		);
		assert.ok(
			at.includes('cols: 3, rows: 3'),
			'弹窗未开时应直接回 3×3（打开总览永远从 3×3 开始，不记上次排版）',
		);
	});
});

suite('防回归：图片不再整库重推后，封面与直播价必须自己长回来', () => {
	function readClient(name: string): string {
		return fs.readFileSync(
			path.join(__dirname, '..', '..', 'src', 'tools', 'shopTool', name),
			'utf-8',
		);
	}

	test('coverInvalidated 必须主动重取那一格的封面', () => {
		const src = readClient('client-main.js');
		const body = /case "coverInvalidated": \{[\s\S]*?\n {4}\}/.exec(src);
		assert.ok(body, '应能定位到 coverInvalidated 分支');
		const at = body![0];
		// 图片操作（上传/拖入/粘贴/清空/删图）不再 loadAll() 之后，coverInvalidated
		// 就是「该编号封面已变」的唯一入口。以前整库刷新会顺带把当前页封面重取一遍，
		// 现在这条链断了：只把格子刷成「无图」而不重取，新图就再也回不来，
		// 用户表现为「上传后列表不更新，得手动点刷新」。
		assert.ok(
			/ensureCovers\(\s*\[\s*\{\s*code:\s*msg\.code\s*\}\s*\]\s*\)/.test(at),
			'coverInvalidated 里应有 ensureCovers([{ code: msg.code }]) 重取封面，' +
				'否则上传/拖入的新图要靠手动刷新才出来',
		);
		// 重核标记也得一起清：ensureCovers 在 coverRecheck 状态下见到 done 就跳过，
		// 留着会让上面那次重取被吞掉，图片行就一直停在「无图」
		assert.ok(
			/coverRecheckDone/.test(at),
			'coverInvalidated 里应清掉该编号的 coverRecheckDone 标记，' +
				'否则正在重核时这次重取会被 ensureCovers 跳过',
		);
	});

	test('coverTile 的每个调用点都必须传重复计数（漏传会把整块九宫格炸没）', () => {
		const src = readClient('client-live.js');
		// coverTile 判「重复」时要读 dupCounts.get()。漏传就是 undefined.get(...)，
		// 而它是在 renderLiveGrid 拼 innerHTML 的 map 回调里执行的 —— 一抛错整块
		// 九宫格就渲染不出来，直播区直接一片空白。这个坑真实发生过一次。
		const calls = [...src.matchAll(/coverTile\(([^)]*)\)/g)].map((m) => m[1]);
		assert.ok(calls.length >= 2, `应至少有两处 coverTile 调用，实际 ${calls.length}`);
		for (const args of calls) {
			assert.ok(
				/dupCounts\s*\)?$/.test(args.trim()),
				`coverTile(${args}) 没传重复计数，判重时会 undefined.get 抛错、整块九宫格不渲染`,
			);
		}
		// 再兜一层：函数体自己也要能在漏传时不炸
		const body = /function coverTile\([\s\S]*?\n {4}\}/.exec(src);
		assert.ok(body, '应能定位到 coverTile 函数体');
		assert.ok(
			/dupCounts\s*\|\|\s*liveDupCounts\(\)/.test(body![0]),
			'coverTile 应在漏传时兜底数一份，不能让 undefined.get 抛出去',
		);
		// 重复判定必须是全局口径：只按组数会把跨组重复漏成正常
		assert.ok(
			/function liveDupCounts\(\)\s*\{[\s\S]*?for \(const r of state\.livePlan\)/.test(src),
			'liveDupCounts 应遍历整份 state.livePlan（跨组重复也要算重复）',
		);
	});

	test('列表/画册的封面右键菜单里得有「删除图片」，且走 deleteCoverImage', () => {
		const src = readClient('client-product.js');
		// openCoverMenu 同时服务列表单元格和画册卡片（两者都带 data-p-act="img"）
		const body = /function openCoverMenu\([\s\S]*?\n\}/.exec(src);
		assert.ok(body, '应能定位到 openCoverMenu 函数体');
		const at = body![0];
		assert.ok(
			/删除图片/.test(at),
			'openCoverMenu 里应有「删除图片」菜单项（列表/画册右键封面直接能删）',
		);
		assert.ok(
			/type:\s*["']deleteCoverImage["']/.test(at),
			'菜单项应 post deleteCoverImage：前端只有 base64、不知道封面文件叫什么，' +
				'得由后台认「当前当封面那张」再删（按序号发过去，夹子被别人动过就会删错）',
		);
		assert.ok(
			/danger:\s*true/.test(at),
			'删图不可逆，菜单项该标 danger（红字）',
		);
	});

	test('商品改价后直播排品区的 ¥售价 必须立刻跟上', () => {
		const live = readClient('client-live.js');
		assert.ok(
			/function refreshLiveMeta\(\)/.test(live),
			'client-live.js 应提供 refreshLiveMeta()：排品格的售价是整块重建时画的，' +
				'改价走增量通知收不到',
		);
		// 刻意不许拿 renderLiveGrid 重来一遍：innerHTML 会把用户正敲着的格子的
		// 输入值和光标一起冲掉
		const body = /function refreshLiveMeta\(\) \{[\s\S]*?\n {4}\}/.exec(live);
		assert.ok(body, '应能定位到 refreshLiveMeta 函数体');
		assert.ok(
			!body![0].includes('renderLiveGrid('),
			'refreshLiveMeta 只能改 .live-meta，不能整块重建（会冲掉正在编辑的输入和焦点）',
		);
		assert.ok(
			body![0].includes('live-meta'),
			'refreshLiveMeta 应只更新每格的 .live-meta 价格标签',
		);

		const main = readClient('client-main.js');
		const delta = /case "productsDelta": \{[\s\S]*?\n {4}\}/.exec(main);
		assert.ok(delta, '应能定位到 productsDelta 分支');
		assert.ok(
			/refreshLiveMeta\(\)/.test(delta![0]),
			'productsDelta 收下改动后应调 refreshLiveMeta()，' +
				'否则直播排品区一直显示改价之前的售价',
		);
		const loaded = /case "productsLoaded": \{[\s\S]*?\n {4}\}/.exec(main);
		assert.ok(loaded, '应能定位到 productsLoaded 分支');
		assert.ok(
			/refreshLiveMeta\(\)/.test(loaded![0]),
			'productsLoaded 也该调 refreshLiveMeta()：手动刷新走这条路，' +
				'applyFreshProducts 只刷封面不刷价格，否则 🔄 之后直播区还是旧价',
		);
	});
});

suite('sharp 句柄用完即释放（跑完立刻删源图必须成功）', () => {
	const roots: string[] = [];

	/**
	 * 先把测的东西说清楚，免得这条 suite 被误读成「destroy 修了删不掉」：
	 *
	 * win32 上量过，libvips 只在**读输入**那一小段时间里占着源文件，读完就放开。
	 * 所以下面每条「跑完立刻 unlinkSync」验的是**管线跑完之后**源文件一定删得掉
	 * （没有残留的映射、没有等 GC 的句柄），以及 withSharpFile 没把这件事弄坏。
	 * 真正会让删除失败的「还在读」那一段，靠的是 handlers/image.ts 里删图前那次
	 * drainInflightThumbs —— 那条在下面单独有用例。
	 */
	async function makePng(w = 100, h = 80): Promise<Buffer> {
		// create 画布不碰磁盘句柄，造测试图自己用 sharp 是安全的
		return sharp({
			create: { width: w, height: h, channels: 3, background: { r: 12, g: 200, b: 90 } },
		})
			.png()
			.toBuffer();
	}

	function makeRoot(): string {
		const root = makeTempDir('handle-');
		roots.push(root);
		return root;
	}

	/** 落一张真图并返回路径 */
	async function seedImg(dir: string, name = 'src.png'): Promise<string> {
		const fp = path.join(dir, name);
		fs.writeFileSync(fp, await makePng());
		return fp;
	}

	/** 跑完立刻删源图：句柄漏出去的话这里必然失败 */
	function mustDeleteNow(fp: string, what: string): void {
		try {
			fs.unlinkSync(fp);
		} catch (err: any) {
			assert.fail(
				`${what} 跑完之后源图还删不掉（${err.code}）——` +
					`说明 sharp 的句柄被攥着没释放。拿磁盘路径开 sharp 必须走 withSharpFile。`,
			);
		}
		assert.strictEqual(fs.existsSync(fp), false, `${what} 之后源图应真的没了`);
	}

	teardown(() => {
		for (const root of roots.splice(0)) {
			// 放弃清理也算通过，原因写在这里免得下次有人当 bug 查：
			// renderStarOverviewBuffer 会把本机 .webp 缩略图再喂回 sharp（liveGrid 的
			// srcOf），而 libvips 读 webp 会给那个文件留下进程级的映射，于是它在本次
			// 测试跑完之前一直删不掉（同目录的 .json、新建文件都正常，不是目录级锁）。
			// 这是缩略图缓存自己的事，跟本 suite 断言的「源图删得掉」无关。
			// 临时目录留给系统清理，比让这条 suite 永远红着好。
			removeTempDir(root);
		}
	});

	test('星标总览预览缩略图：build 完之后立刻删源图', async () => {
		const root = makeRoot();
		const src = await seedImg(root);

		const built = await previewThumbPath(src, path.join(root, 'cache'), 'L001', true);

		assert.ok(built, '应当真的缩出一张（否则这条用例什么也没验）');
		mustDeleteNow(src, 'previewThumbPath');
	});

	test('星标总览（预览 / 导出两条路）跑完立刻删源图', async () => {
		const root = makeRoot();
		const rows = [
			{ code: 'L001', img: (await seedImg(root, 'a.png')) as string | null, price: 10, costPrice: 5 },
			{ code: 'L002', img: (await seedImg(root, 'b.png')) as string | null, price: 20, costPrice: 8 },
		];
		const labels = { code: true, costPrice: true, salePrice: true, fontSize: 0 };

		// 预览：走 imgFor 拿本机小图（小图由 previewThumbPath 现生成，正好串上那条路）
		await renderStarOverviewBuffer(rows, 2, 1, labels, {
			preview: true,
			imgFor: async (_code, s) => previewThumbPath(s as string, path.join(root, 'cache'), 'X', true),
		});
		mustDeleteNow(rows[0].img as string, 'renderStarOverviewBuffer（预览）');
		mustDeleteNow(rows[1].img as string, 'renderStarOverviewBuffer（预览）');

		// 导出：不传 imgFor，直接吃原图
		const root2 = makeRoot();
		const rows2 = [
			{ code: 'L001', img: (await seedImg(root2, 'a.png')) as string | null, price: 10, costPrice: 5 },
		];
		await renderStarOverviewBuffer(rows2, 1, 1, labels);
		mustDeleteNow(rows2[0].img as string, 'renderStarOverviewBuffer（导出）');
	});

	test('直播排品九宫格跑完立刻删源图', async () => {
		const root = makeRoot();
		const cells = [];
		for (let i = 0; i < 9; i++) {
			cells.push({ code: `L00${i + 1}`, img: (await seedImg(root, `g${i}.png`)) as string | null });
		}
		const outDir = path.join(root, 'out');
		fs.mkdirSync(outDir);

		const out = await renderLiveGrid(cells, outDir, 1, 'num');

		assert.ok(fs.existsSync(out), '九宫格应真的出图');
		for (const c of cells) {
			mustDeleteNow(c.img as string, 'renderLiveGrid');
		}
	});

	test('九宫格工具箱：拼图 / 压序号 跑完立刻删源图', async () => {
		const root = makeRoot();
		const imgs: string[] = [];
		for (let i = 0; i < 9; i++) {
			imgs.push(await seedImg(root, `n${i}.png`));
		}
		const outDir = path.join(root, 'out');
		fs.mkdirSync(outDir);

		const grid = await handleNineGridMergeFromList(imgs, outDir);
		assert.ok(fs.existsSync(grid));
		for (const fp of imgs) {
			mustDeleteNow(fp, 'handleNineGridMergeFromList');
		}

		// 压序号读的是刚拼出来那张大图
		const labeled = await handleNineGridLabel(grid, 1, outDir);
		assert.ok(fs.existsSync(labeled));
		mustDeleteNow(grid, 'handleNineGridLabel');
	});

	test('原地旋转 90°：它自己就要 unlink 源文件，句柄漏出去就必失败', async () => {
		const root = makeRoot();
		const fp = await seedImg(root);

		await rotateImageInPlace(fp);

		// 100×80 转完是 80×100：既证明文件没丢，也证明它是被重写过的
		const job = sharp(fp);
		try {
			const meta = await job.metadata();
			assert.deepStrictEqual([meta.width, meta.height], [80, 100]);
		} finally {
			job.destroy();
		}
		assert.deepStrictEqual(fs.readdirSync(root), ['src.png'], '不该留下 .rotate_tmp_ 残留');
	});

	test('防回归：拿磁盘路径开 sharp 的地方都走 withSharpFile（数字是刻意写死的）', () => {
		// out/test/ → out/ → 仓库根，再进 src/（编译产物只拷 .js，源码得回 src 找）
		const repoSrc = path.join(__dirname, '..', '..', 'src');
		const read = (rel: string) => fs.readFileSync(path.join(repoSrc, rel), 'utf-8');
		const count = (rel: string, re: RegExp) => (read(rel).match(re) ?? []).length;

		// 新加一处「拿磁盘路径开 sharp」时：把对应数字 +1，并确认那一处真的走了
		// withSharpFile。写死而不是 >= ：这样漏掉时才会红。
		const expect: Array<[string, number, string]> = [
			['core/utils.ts', 1, 'withSharpFile 自己的声明'],
			['tools/shopTool/images.ts', 2, '封面缩略图 + 星标预览缩略图'],
			['tools/shopTool/liveGrid.ts', 4, '探尺寸 ×2 + 缩格 ×2'],
			['tools/nineGridTool/index.ts', 5, '探尺寸 ×2 + 缩格 + 压序号 + 旋转'],
		];
		for (const [rel, n, what] of expect) {
			assert.strictEqual(
				count(rel, /withSharpFile\(/g),
				n,
				`${rel} 里 withSharpFile 的调用数应恰好是 ${n}（${what}）。` +
					`新加/漏改了一处「拿磁盘路径开 sharp」，请改成 withSharpFile 并把数字同步过来。`,
			);
		}

		// 剩下的裸 sharp( 只该是新画布（不碰磁盘句柄）与 Buffer 入参（也不碰）
		assert.strictEqual(
			count('tools/shopTool/liveGrid.ts', /sharp\(\{/g),
			2,
			'liveGrid.ts 里只应有 2 处裸「新建画布」调用',
		);
		assert.strictEqual(
			count('tools/nineGridTool/index.ts', /sharp\(\{/g),
			1,
			'nineGridTool 里只应有 1 处裸「新建画布」调用',
		);
		assert.strictEqual(
			count('tools/shopTool/images.ts', /sharp\(/g),
			0,
			'images.ts 里不该再有裸 sharp( 调用（两处缩略图都该走 withSharpFile）',
		);
	});

	test('后台缩略图：drainInflightThumbs 真的等到了它们（删图前靠这个不撞「正在读」）', async function () {
		this.timeout(15000);
		const root = makeRoot();
		const cacheDir = path.join(root, 'cache');
		const srcs: string[] = [];
		for (let i = 0; i < 6; i++) {
			srcs.push(await seedImg(root, `p${i}.png`));
		}

		// build=false：立刻返回 null、把缩图丢到后台 —— 星标总览预览走的就是这条。
		// 编号要各不相同：缓存键是 {编号}@p512，同编号会写进同一个文件、互相盖掉。
		for (let i = 0; i < srcs.length; i++) {
			assert.strictEqual(await previewThumbPath(srcs[i], cacheDir, `L00${i + 1}`), null);
		}
		// 不等的话，缓存目录此刻多半还是空的（6 个后台任务刚起）
		await drainInflightThumbs();

		const cached = fs
			.readdirSync(path.join(cacheDir, 'shop_thumbs'))
			.filter((f) => f.endsWith('.webp'));
		assert.strictEqual(cached.length, srcs.length, 'drain 之后 6 张小图应全部落盘');
		// 等完之后源图立刻删得掉：这正是删图路径依赖的性质
		for (const src of srcs) {
			mustDeleteNow(src, 'drainInflightThumbs 之后');
		}
	});

	test('drain 有上限：共享盘断连那种永远不落地的活儿，拖不死删除', async function () {
		this.timeout(15000);
		// 造不出「永远不落地」的活儿（那是共享盘断连才有的情形），所以这条只作冒烟：
		// API 存在、参数认得、并且自己会回来。真断连时的行为靠 maxMs 这个上限兜。
		const t0 = Date.now();
		await drainInflightThumbs(120);
		assert.ok(Date.now() - t0 < 2000, 'drain 必须自己会回来');
	});
});

suite('导入：相同字段不再重写', () => {
	const roots: string[] = [];

	teardown(function () {
		closeDB();
		for (const root of roots.splice(0)) {
			removeTempDir(root);
		}
	});

	function makeRoot(): string {
		const root = makeTempDir('imp-');
		roots.push(root);
		return root;
	}

	/** 真库（initDB 真的落一个 SQLite 文件），再把两个写方法包一层数调用次数 */
	function createImportHarness(storageDir: string) {
		assert.strictEqual(initDB(storageDir), true, 'initDB 应当成功打开新库');
		const db = getDB();
		const posts: any[] = [];
		const logs: string[] = [];
		const h = {
			db,
			setDB: () => {},
			log: (s: string) => { logs.push(s); },
			post: (m: any) => { posts.push(m); },
			getSetting: () => '',
			setSetting: async () => {},
			readOnly: () => false,
			localPrefKey: () => false,
			postLocalPrefs: () => {},
			imageDir: () => '',
			coverCache: new Map(),
			invalidateCover: () => {},
			removeImageFolder: () => false,
			renameImageFolder: () => 'noop',
			loadAll: () => {},
			postProductsDelta: () => {},
			refreshSales: () => {},
			postStockIns: () => {},
			postLiveState: () => {},
			preOpBackup: async () => {},
			snapshot: () => ({ tables: {} }) as any,
			pushUndo: () => {},
			resetUndo: () => {},
		} as unknown as HandlerCtx;

		const writes: Array<{ field: string; value: unknown }> = [];
		const adds: unknown[] = [];
		const realUpdate = db.updateProductField.bind(db);
		const realAdd = db.addProduct.bind(db);
		(db as any).updateProductField = (id: number, field: string, value: unknown) => {
			writes.push({ field, value });
			return realUpdate(id, field, value);
		};
		(db as any).addProduct = (row: unknown) => {
			adds.push(row);
			return realAdd(row as any);
		};
		return { db, h, posts, logs, writes, adds, handlers: productHandlers(h) };
	}

	// 导入列序：code, name, category, series, grade, cost_price, sale_price, status, purchase_link
	const HEAD = '编号\t名称\t品类\t系列\t等级\t进价\t售价\t状态\t采购链接';
	const A = 'L001\t手链A\t水晶\t银饰\t1\t20\t\t\t';
	const B = 'L002\t手链B\t木头\t木头\t2\t30\t\t\t';

	async function run(harness: any, text: string, mode: string): Promise<{ preview: any; done: any }> {
		harness.posts.length = 0;
		await harness.handlers.previewImportProducts({ text, mode }, harness.h);
		const preview = harness.posts.find((m: any) => m.type === 'importPreview');
		assert.ok(preview, '应当发出 importPreview');
		harness.posts.length = 0;
		await harness.handlers.commitImportProducts({ token: preview.token }, harness.h);
		const done = harness.posts.find((m: any) => m.type === 'productsImported');
		assert.ok(done, '应当发出 productsImported');
		return { preview, done };
	}

	test('同一份文件导两次：第二次字段写入 0 次，全算跳过', async function () {
		const harness = createImportHarness(makeRoot());
		const text = [HEAD, A, B].join('\n');

		const first = await run(harness, text, 'both');
		assert.strictEqual(first.done.created, 2, '首次应当新增 2 条');
		assert.strictEqual(harness.adds.length, 2);

		// 关键：第二次一个字都不该再写进库
		harness.writes.length = 0;
		const second = await run(harness, text, 'both');
		assert.strictEqual(
			harness.writes.length,
			0,
			`重复导入不该有字段写入，实际写了：${JSON.stringify(harness.writes)}`,
		);
		assert.strictEqual(second.preview.updated, 0, '预览就应当显示更新 0');
		assert.strictEqual(second.done.updated, 0);
		assert.strictEqual(second.done.skipped, 2, '两行都应计入跳过');
		assert.ok(
			harness.logs.some((l: string) => l.includes('新增 0，更新 0，跳过 2')),
			`日志应当报 0 写 2 跳过：${JSON.stringify(harness.logs)}`,
		);
	});

	test('只改一个字段：只写那一个字段', async function () {
		const harness = createImportHarness(makeRoot());
		await run(harness, [HEAD, A, B].join('\n'), 'both');

		// L001 名称改成别的，其余原样
		harness.writes.length = 0;
		const changed = 'L001\t手链A改\t水晶\t银饰\t1\t20\t\t\t';
		const r = await run(harness, [HEAD, changed, B].join('\n'), 'both');
		assert.strictEqual(r.done.updated, 1, '只有 L001 真有变化');
		assert.deepStrictEqual(harness.writes, [{ field: 'name', value: '手链A改' }]);
		assert.strictEqual(harness.db.getProductByCode('L001')!.name, '手链A改');
		assert.strictEqual(harness.db.getProductByCode('L002')!.name, '手链B', 'L002 不该被动');
	});

	test('无变化的行仍进预览表标（无变化），不会被看着像丢行', async function () {
		const harness = createImportHarness(makeRoot());
		await run(harness, [HEAD, A, B].join('\n'), 'both');
		harness.posts.length = 0;
		await harness.handlers.previewImportProducts({ text: [HEAD, A, B].join('\n'), mode: 'both' }, harness.h);
		const preview = harness.posts.find((m: any) => m.type === 'importPreview');
		assert.strictEqual(preview.skipped, 2);
		assert.strictEqual(preview.rows.length, 2, '两行都应当列出来，不是只报个数');
		for (const r of preview.rows) {
			assert.strictEqual(r.detail, '（无变化）', `应当标无变化：${JSON.stringify(r)}`);
		}
	});

	test('重复编号：预览与提交都把具体行号发出去（否则只能去日志里翻）', async function () {
		const harness = createImportHarness(makeRoot());
		// A001 出现两次：第二条会被判重复，只保留第一条
		const dup = 'L001\t手链A又来\t水晶\t银饰\t1\t25\t\t\t';
		const text = [HEAD, A, dup, B].join('\n');

		const { preview, done } = await run(harness, text, 'both');
		const want = '行3: 编号 L001 重复，仅保留第一条';
		assert.strictEqual(preview.duplicates, 1, '预览要报重复计数');
		assert.deepStrictEqual(preview.duplicateLines, [want], '预览要带具体行号');
		assert.strictEqual(done.duplicates, 1, '提交也要报重复计数');
		assert.deepStrictEqual(
			done.duplicateLines,
			[want],
			`提交消息必须带具体行号，前端弹窗才有内容可显示：${JSON.stringify(done)}`,
		);
		assert.strictEqual(harness.adds.length, 2, '重复的那行不进库');
		assert.strictEqual(harness.db.getProductByCode('L001')!.name, '手链A', '只保留第一条');
	});

	test('没有重复时两个字段都是空，弹窗不会被无谓触发', async function () {
		const harness = createImportHarness(makeRoot());
		const { preview, done } = await run(harness, [HEAD, A, B].join('\n'), 'both');
		assert.strictEqual(preview.duplicates, 0);
		assert.deepStrictEqual(preview.duplicateLines, []);
		assert.strictEqual(done.duplicates, 0);
		assert.deepStrictEqual(done.duplicateLines, [], '空数组，前端按长度判断就不弹');
	});

	test('前端契约：提交完有行没进去时弹模态框，预览也列具体行', () => {
		const read = (f: string) =>
			fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', 'shopTool', f), 'utf-8');
		const main = read('client-main.js');
		const prod = read('client-product.js');

		assert.ok(
			/showImportIssues\(importBad,\s*importDups\)/.test(main),
			'productsImported 分支必须在有行没进去时调 showImportIssues',
		);
		assert.ok(
			/msg\.duplicateLines/.test(main),
			'弹窗数据必须取 duplicateLines（不是计数用的 duplicates）',
		);
		assert.ok(/function showImportIssues\(/.test(prod), 'showImportIssues 要存在');
		assert.ok(
			/showModal\(/.test(prod) && /closeModal\(\)/.test(prod),
			'必须用模态框（showModal）且能关闭，不是 toast（toast 几秒就没了，行号来不及改）',
		);
		assert.ok(
			/overflow:auto/.test(prod),
			'弹窗列表要能滚动，否则行数一多按钮就被顶出去',
		);
		assert.ok(
			/duplicateLines/.test(prod) && /编号重复/.test(prod),
			'预览区要列出具体的重复行，不能只给个数',
		);
	});
});

/**
 * 共享缩略图缓存：客机第一次看某个商品时，本机缓存是空的，原来只能从共享盘把几 MB 的原图
 * 整张读过来现缩；有了共享缓存就直接读几十 KB 的小图。这里钉住三件事——
 * 跨机复用（盘符不同也要命中）、源图变了不能发旧图、只读机只读不写。
 */
suite('共享缩略图缓存（客机不再从共享盘拉原图）', () => {
	const roots: string[] = [];

	function makeRoot(prefix: string): string {
		const root = makeTempDir(prefix);
		roots.push(root);
		return root;
	}

	teardown(() => {
		for (const root of roots.splice(0)) {
			removeTempDir(root);
		}
	});

	/** 一张能被 sharp 解码的真图（1px PNG 缩出来全一样，验不出「读的是谁的小图」） */
	async function photo(w = 240, h = 160): Promise<Buffer> {
		return sharp({
			create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } },
		})
			.png()
			.toBuffer();
	}

	/**
	 * 造「两台机器上的同一个商品夹」：绝对路径不同、内容不同、但大小与 mtime 一致。
	 * B 机那份刻意写成解不出来的字节：万一没命中共享缓存，缩图必然失败、回退成原图 base64，
	 * 结果就不可能等于 A 机那张 webp —— 用它来证明「B 读的是共享缓存，不是自己的原图」。
	 */
	async function twoMachines(): Promise<{
		shared: string;
		srcA: string;
		srcB: string;
		folderA: string;
		folderB: string;
	}> {
		const shared = makeRoot('thumb-shared-');
		const dirA = path.join(makeRoot('thumb-machA-'), 'L001');
		const dirB = path.join(makeRoot('thumb-machB-'), 'L001');
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		const srcA = path.join(dirA, 'shot.png');
		const srcB = path.join(dirB, 'shot.png');
		const bytes = await photo();
		fs.writeFileSync(srcA, bytes);
		fs.writeFileSync(srcB, Buffer.alloc(bytes.length, 0x41));
		const t = new Date('2026-05-01T10:00:00Z');
		fs.utimesSync(srcA, t, t);
		fs.utimesSync(srcB, t, t);
		return { shared, srcA, srcB, folderA: dirA, folderB: dirB };
	}

	test('A 机缩好放进共享缓存，B 机（另一套路径、本机缓存为空）直接复用那张小图', async () => {
		const { shared, srcA, srcB } = await twoMachines();
		const a = await thumbToCachedBase64(srcA, makeRoot('thumb-loA-'), 'L001', 'shot.png', {
			root: shared,
		});
		assert.ok(a.startsWith('data:image/webp'), `应产出 webp 缩略图，实际 ${a.slice(0, 30)}`);
		assert.ok(
			fs.readdirSync(shared).some((f) => f.endsWith('.webp')),
			'共享缓存里应落下小图',
		);

		const localB = makeRoot('thumb-loB-');
		const b = await thumbToCachedBase64(srcB, localB, 'L001', 'shot.png', { root: shared });
		assert.strictEqual(b, a, 'B 机应直接拿到 A 机写下的那张小图，而不是缩自己的原图');
		assert.ok(
			fs.readdirSync(path.join(localB, 'shop_thumbs')).some((f) => f.endsWith('.webp')),
			'命中共享缓存后应顺手回填本机缓存',
		);
	});

	test('源图 mtime 变了：共享缓存不再命中，不许把旧图发出去', async () => {
		const { shared, srcA, srcB } = await twoMachines();
		const a = await thumbToCachedBase64(srcA, makeRoot('thumb-loA2-'), 'L001', 'shot.png', {
			root: shared,
		});
		const later = new Date('2026-05-02T10:00:00Z');
		fs.utimesSync(srcB, later, later);
		const b = await thumbToCachedBase64(srcB, makeRoot('thumb-loB2-'), 'L001', 'shot.png', {
			root: shared,
		});
		assert.notStrictEqual(b, a, '指纹对不上就该重缩（宁可慢一张，也不能让人看到旧图）');
	});

	test('只读机：共享缓存照读不误，但一张都不往共享盘写', async () => {
		const { srcA } = await twoMachines();
		// 用一个**还不存在**的共享缓存根：只读模式一旦去建目录/写文件就会露馅
		const sharedNew = path.join(makeRoot('thumb-ro-root-'), 'shop_thumbs_shared');
		const ro = await thumbToCachedBase64(srcA, makeRoot('thumb-loRo-'), 'L001', 'shot.png', {
			root: sharedNew,
			writable: false,
		});
		assert.ok(ro.startsWith('data:image/webp'), '只读模式下仍应出图（现缩，只是不写共享盘）');
		assert.strictEqual(fs.existsSync(sharedNew), false, '只读模式不该在共享盘上创建缓存目录');
	});

	test('sharedThumbRoot：没另配数据目录（storageDir === defaultStorageDir）就不启用共享层', () => {
		const same = makeRoot('thumb-same-');
		assert.strictEqual(sharedThumbRoot(same, same), '', '同一目录没有第二台机器会读，白占磁盘');
		assert.strictEqual(sharedThumbRoot('', same), '');
		const net = makeRoot('thumb-net-');
		assert.strictEqual(sharedThumbRoot(net, same), path.join(net, 'shop_thumbs_shared'));
	});

	test('sharedThumbReady 只认指纹：源图换了（大小/mtime 变）就算没缩过', async () => {
		const { shared, srcA, folderA } = await twoMachines();
		await thumbToCachedBase64(srcA, makeRoot('thumb-loR-'), 'L001', 'shot.png', { root: shared });
		assert.strictEqual(sharedThumbReady(srcA, shared, 'L001', 'shot.png'), true);

		const replaced = path.join(folderA, 'shot.png');
		fs.writeFileSync(replaced, await photo(40, 40));
		const t = new Date('2026-05-01T10:00:00Z');
		fs.utimesSync(replaced, t, t);
		assert.strictEqual(sharedThumbReady(replaced, shared, 'L001', 'shot.png'), false);
	});

	test('预生成：封面与图库每张都进共享缓存，重复点全部跳过', async () => {
		const imgRoot = makeRoot('thumb-imgs-');
		const storage = makeRoot('thumb-storage-');
		const local = makeRoot('thumb-host-');
		for (const [code, n] of [
			['L001', 3],
			['L002', 1],
		] as Array<[string, number]>) {
			const folder = path.join(imgRoot, code);
			fs.mkdirSync(folder, { recursive: true });
			for (let i = 0; i < n; i++) {
				fs.writeFileSync(path.join(folder, `${code}_${i}.png`), await photo(120, 80));
			}
		}
		const logs: string[] = [];
		const h = {
			ctx: {
				storageDir: storage,
				defaultStorageDir: local,
				// 宿主那一层：handler 现在只认 ctx.imageUrl / revealInOS / pickStorageDir，
				// 不再直接碰 panel.webview（那是 VS Code 宿主的事）
				imageUrl: (fp: string) => `file:///${String(fp).replace(/\\/g, "/")}`,
				revealInOS: async () => undefined,
				pickStorageDir: async () => undefined,
			} as unknown as ToolContext,
			imageDir: () => imgRoot,
			coverCache: new Map(),
			readOnly: () => false,
			log: (s: string) => logs.push(s),
			post: () => undefined,
			preOpBackup: async () => undefined,
			invalidateCover: () => undefined,
			loadAll: () => undefined,
			db: {
				getProducts: () => [
					{ id: 1, code: 'L001' },
					{ id: 2, code: 'L002' },
					{ id: 3, code: 'L003' },
				],
			},
		} as unknown as HandlerCtx;
		/** 预生成是后台跑的（不 await），等到汇总那行为止 */
		const waitSummary = async (): Promise<string> => {
			for (let i = 0; i < 400; i++) {
				const done = logs.filter((l) => l.startsWith('✅') || l.startsWith('❌'));
				if (done.length) {
					return done[done.length - 1];
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			throw new Error(`没等到汇总日志：${logs.join(' | ')}`);
		};

		imageHandlers(h).buildSharedThumbs({}, h);
		const first = await waitSummary();
		assert.ok(first.includes('新生成 6 张'), `2 封面 + 4 张图应全部新生成，实际：${first}`);

		const sharedRoot = path.join(storage, 'shop_thumbs_shared');
		const files = fs.readdirSync(sharedRoot).filter((f) => f.endsWith('.webp'));
		assert.strictEqual(
			files.filter((f) => /@512\.webp$/.test(f) && !f.includes('~')).length,
			2,
			`应有 L001/L002 两枚封面，实际 ${files.join(',')}`,
		);
		assert.strictEqual(
			files.filter((f) => /~[0-9a-f]{8}@512\.webp$/.test(f)).length,
			4,
			`应有 4 枚按文件名存的图库小图，实际 ${files.join(',')}`,
		);
		assert.ok(
			!files.some((f) => f.startsWith('L003')),
			'没有图片夹的商品不该产出任何缩略图',
		);

		// 清掉上一轮的日志：waitSummary 取的是最后一行 ✅，不清就会把第一轮的汇总当成第二轮的
		logs.length = 0;
		imageHandlers(h).buildSharedThumbs({}, h);
		const second = await waitSummary();
		assert.ok(second.includes('新生成 0 张'), `已缩过的必须跳过，实际：${second}`);
		assert.ok(second.includes('已有 6 张'), `实际：${second}`);
	});
	test('没另配数据存储目录时给出可操作的提示，不是静默什么都不做', () => {
		const same = makeRoot('thumb-plain-');
		const logs: string[] = [];
		const h = {
			ctx: {
				storageDir: same,
				defaultStorageDir: same,
				// 宿主那一层：handler 现在只认 ctx.imageUrl / revealInOS / pickStorageDir，
				// 不再直接碰 panel.webview（那是 VS Code 宿主的事）
				imageUrl: (fp: string) => `file:///${String(fp).replace(/\\/g, "/")}`,
				revealInOS: async () => undefined,
				pickStorageDir: async () => undefined,
			} as unknown as ToolContext,
			imageDir: () => same,
			coverCache: new Map(),
			readOnly: () => false,
			log: (s: string) => logs.push(s),
			post: () => undefined,
			preOpBackup: async () => undefined,
			invalidateCover: () => undefined,
			loadAll: () => undefined,
			db: { getProducts: () => [] },
		} as unknown as HandlerCtx;

		imageHandlers(h).buildSharedThumbs({}, h);
		assert.ok(
			logs.some((l) => l.includes('没有可共享的缓存位置')),
			`实际日志：${logs.join(' | ')}`,
		);
	});
});

/**
 * 前端契约（跟本文件其它「前端契约」用例同一套路）：这两处改动都在 webview 里，
 * 无头测试点不到，所以读源码钉住关键接线——真正容易被人后来改坏的正是这些接线。
 */
suite('前端契约：状态下拉与画册卡片大小', () => {
	const read = (f: string) =>
		fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'tools', 'shopTool', f), 'utf-8');

	test('「搜哪一列 = 状态」时换成下拉，选项与 cellValue 的中文标签同一出处', () => {
		const html = read('fragment.html');
		const main = read('client-main.js');
		const prod = read('client-product.js');

		assert.ok(/id="keywordStatus"/.test(html), '工具栏要有状态下拉这个控件');
		assert.ok(/id="keywordSearchWrap"/.test(html), '输入框那层要有 id，切到状态时整块藏起来');
		assert.ok(
			/\.tb-search\[hidden\]/.test(html),
			'.tb-search 是 display:flex，会盖掉浏览器默认的 [hidden]{display:none}，必须自己补一条',
		);
		assert.ok(
			/const STATUS_LABELS = \{ on: "在售", off: "已下架" \}/.test(prod) &&
				/p\.status === 1 \? STATUS_LABELS\.off : STATUS_LABELS\.on/.test(prod),
			'「在售/已下架」只能有 STATUS_LABELS 一处定义，cellValue 从它取（否则漏斗与下拉会各叫各的）',
		);
		assert.ok(
			/STATUS_FILTER_OPTIONS/.test(prod) && /STATUS_FILTER_OPTIONS/.test(main),
			'下拉选项要由 client-main 从 client-product 的 STATUS_FILTER_OPTIONS 生成，不许再抄一份标签',
		);
		assert.ok(
			/isStatusScope\(\)/.test(main) && /activeKeywordRaw/.test(main),
			'搜索词要按当前列从对应控件取：状态读下拉，其余读输入框',
		);
		assert.ok(
			/kwStatusSel\.onchange = applyKeyword/.test(main),
			'下拉选完要立即生效（下拉没有「回车才应用」的说法）',
		);
	});

	test('画册卡片大小：档位可调、走本机偏好、切回列表自动收起', () => {		const html = read('fragment.html');
		const main = read('client-main.js');
		const prod = read('client-product.js');
		const idx = read('index.ts');

		assert.ok(
			/id="gallerySize"/.test(html) && /value="xl"/.test(html),
			'工具栏要有画册大小下拉，且最大那档比原来大得多',
		);
		assert.ok(
			/var\(--card-w/.test(html) && /var\(--card-h/.test(html),
			'卡片宽高要走 CSS 变量（.card-grid / .card img），写死像素就没人能调',
		);
		assert.ok(
			/const GALLERY_SIZES = \{/.test(prod) && /function applyGallerySize/.test(prod),
			'档位表与落点函数要存在（宽高成对给，只给宽度会把封面裁成一条竖片）',
		);
		assert.ok(
			/saveGallerySize\(/.test(main) && /syncGallerySizeVisibility/.test(main),
			'换档要存本机偏好；切到列表视图要收起这个下拉',
		);
		assert.ok(
			/"gallery_size"/.test(idx),
			'gallery_size 必须进 LOCAL_PREF_KEYS（各人屏幕宽窄不同，不能写进共享库）',
		);
	});

	test('下拉选完交还焦点（滚轮不再把带焦点的 select 当上下键使）', () => {
		const core = read('client-core.js');
		const main = read('client-main.js');

		assert.ok(/function installSelectBlurAfterPick\(/.test(core), '交还焦点的函数要存在');
		assert.ok(
			/document\.addEventListener\("change"/.test(core) && /sel\.blur\(\)/.test(core),
			'要在 document 上委托 change 再 blur —— 委托才盖得住各处动态生成的下拉（抽屉、内联编辑器、弹窗）',
		);
		assert.ok(
			/sel\.tagName !== "SELECT"/.test(core),
			'只处理下拉的 change，别把输入框/复选框的改动也顺手 blur 了',
		);
		assert.ok(
			/pointerdown/.test(core) && /byPointer/.test(core),
			'只对鼠标来的那次改动 blur：键盘用户按 ↑↓ 换档时焦点被抽走的话，每换一档都得重新 Tab 回来',
		);
		assert.ok(
			/document\.__shopSelectBlurAfterPick/.test(core),
			'安装要幂等且标记挂 document 上：切工具时脚本会重新执行一遍，模块级标志会被重置',
		);
		assert.ok(
			!/installSelectWheelGuard|scrollAncestorBy/.test(core),
			'不要再叠回「拦 wheel + 转发滚动量」那套（第一版）：商品管理页里真正的滚动容器是工具栏的**兄弟**，' +
				'祖先链上找不到能滚的东西，量会被丢掉、鼠标停在工具栏上反而更滚不动；两套机制并存只会互相打架',
		);
		assert.ok(/installSelectBlurAfterPick\(\)/.test(main), 'bindEvents 里要真的把它装上');
	});

	/**
	 * 上面那条是「源码里有没有这些接线」，这条把它**真跑一遍**：那段逻辑只碰 `document`
	 * （一个 addEventListener），所以抽出来喂个假 document 就能驱动它——三个分支
	 * （鼠标改 / 键盘改 / 非下拉的 change）和幂等性都是行为级断言，不是读字符串。
	 * 浏览器里点不到的东西，这是能拿到的最硬的证据。
	 */
	test('交还焦点的行为：鼠标改完 blur、键盘改完不动、非下拉的 change 不碰', () => {
		const src = read('client-core.js');
		const begin = src.indexOf('function installSelectBlurAfterPick(');
		assert.ok(begin >= 0, '先得在 client-core.js 里找到那个函数');
		// 花括号配平切出函数体：函数里有两层嵌套的箭头函数，正则截不可靠
		let depth = 0;
		let end = -1;
		for (let i = src.indexOf('{', begin); i < src.length; i++) {
			if (src[i] === '{') {
				depth++;
			} else if (src[i] === '}') {
				depth--;
				if (depth === 0) {
					end = i + 1;
					break;
				}
			}
		}
		assert.ok(end > begin, '函数体要能配平切出来');
		const make = new Function(
			'document',
			`${src.slice(begin, end)}; return installSelectBlurAfterPick;`,
		) as (doc: unknown) => () => void;

		/** 假 document：只实现 addEventListener，回调按类型收好，测试里手动触发 */
		const handlers: Record<string, Array<(e: any) => void>> = {};
		const fakeDoc = {
			addEventListener: (t: string, fn: (e: any) => void) => {
				(handlers[t] = handlers[t] || []).push(fn);
			},
		};
		const fire = (t: string, e: any) => (handlers[t] || []).forEach((fn) => fn(e));

		const install = make(fakeDoc);
		install();
		install(); // 幂等：装第二遍不该再挂一组
		assert.strictEqual((handlers.change || []).length, 1, '重复安装不该挂第二组监听');

		const mouseSel = { tagName: 'SELECT', blurred: 0, blur() { this.blurred++; } };
		fire('pointerdown', { target: { closest: () => mouseSel } });
		fire('change', { target: mouseSel });
		assert.strictEqual(mouseSel.blurred, 1, '鼠标选完要交还焦点（滚轮才不会拿它当上下键）');

		const kbSel = { tagName: 'SELECT', blurred: 0, blur() { this.blurred++; } };
		fire('keydown', {});
		fire('change', { target: kbSel });
		assert.strictEqual(kbSel.blurred, 0, '键盘改完不能抽走焦点，否则每换一档都要重新 Tab 回来');

		const input = { tagName: 'INPUT', blurred: 0, blur() { this.blurred++; } };
		fire('pointerdown', { target: { closest: () => input } });
		fire('change', { target: input });
		assert.strictEqual(input.blurred, 0, '非下拉的 change 不该被碰');
		// 上一次 change 已经把手势标记读掉了：紧接着来一次没有鼠标前提的下拉改动，不该 blur
		const stray = { tagName: 'SELECT', blurred: 0, blur() { this.blurred++; } };
		fire('change', { target: stray });
		assert.strictEqual(stray.blurred, 0, '鼠标标记只能被一次 change 用掉');
	});
});

/**
 * 九宫格/星标总览原来是**串行**读原图（一格一格等），共享盘上慢得离谱；改成并发读之后
 * 最容易踩的两个坑：并发回来的顺序把格子拼错位、以及某一格读失败把整张图带走。
 * 这两条都用"生成真图再采样像素"来钉，而不是读源码字符串——位置对不对，只有像素说了算。
 */
suite('九宫格 / 星标总览：并发读图不打乱位置、单格失败不毁整张', () => {
	const roots: string[] = [];

	function makeRoot(prefix: string): string {
		const root = makeTempDir(prefix);
		roots.push(root);
		return root;
	}

	teardown(() => {
		for (const root of roots.splice(0)) {
			removeTempDir(root);
		}
	});

	// 9 个彼此相距很远的纯色：任意两个至少在某个通道差 127，JPEG 那点抖动吃不掉这个距离
	const COLORS = [
		{ r: 255, g: 0, b: 0 },
		{ r: 0, g: 255, b: 0 },
		{ r: 0, g: 0, b: 255 },
		{ r: 255, g: 255, b: 0 },
		{ r: 0, g: 255, b: 255 },
		{ r: 255, g: 0, b: 255 },
		{ r: 128, g: 128, b: 128 },
		{ r: 255, g: 128, b: 0 },
		{ r: 0, g: 128, b: 255 },
	];

	/** 9 张 300×300 纯色 PNG（300 < 1024，不会被放大 → tile=300，canvas=900×900） */
	async function seedColored(dir: string): Promise<string[]> {
		fs.mkdirSync(dir, { recursive: true });
		const out: string[] = [];
		for (let i = 0; i < 9; i++) {
			const fp = path.join(dir, `c${i}.png`);
			await sharp({
				create: { width: 300, height: 300, channels: 3, background: COLORS[i] },
			})
				.png()
				.toFile(fp);
			out.push(fp);
		}
		return out;
	}

	/**
	 * 采样每格里的一个点（取格内 10% 处，避开灰底占位那张"无图"文字，它在格子正中）。
	 * 纯色块任何点都一样，取 10% 只是为了让灰底那格不采到字上。
	 */
	async function sampleCells(outFile: string, tile = 300, cols = 3) {
		const { data, info } = await sharp(outFile).raw().toBuffer({ resolveWithObject: true });
		const at = (idx: number) => {
			const col = idx % cols;
			const row = Math.floor(idx / cols);
			const x = col * tile + Math.round(tile * 0.1);
			const y = row * tile + Math.round(tile * 0.1);
			const p = (y * info.width + x) * info.channels;
			return { r: data[p], g: data[p + 1], b: data[p + 2] };
		};
		return { at, info };
	}

	const near = (
		got: { r: number; g: number; b: number },
		want: { r: number; g: number; b: number },
		tol = 24,
	): boolean =>
		Math.abs(got.r - want.r) <= tol &&
		Math.abs(got.g - want.g) <= tol &&
		Math.abs(got.b - want.b) <= tol;

	test('九宫格：并发读图后 9 格仍按格子位置归位（每格是自己的那张图）', async function () {
		this.timeout(15000);
		const root = makeRoot('grid-order-');
		const files = await seedColored(path.join(root, 'imgs'));
		const outDir = path.join(root, 'out');
		fs.mkdirSync(outDir);
		const cells = files.map((fp, i) => ({
			code: `L${String(i + 1).padStart(3, '0')}`,
			img: fp,
		}));

		// labelMode='none'：不压文字，采样点就只剩纯色可读
		const out = await renderLiveGrid(cells, outDir, 1, 'none');

		const { at, info } = await sampleCells(out);
		assert.strictEqual(info.width, 900, '3 格 × 300 = 900（300 小于上限 1024，不放大）');
		for (let i = 0; i < 9; i++) {
			assert.ok(
				near(at(i), COLORS[i]),
				`第 ${i + 1} 格应该是第 ${i + 1} 张图，实际采到 ${JSON.stringify(at(i))}`,
			);
		}
	});

	test('九宫格：某一格读不到图时灰底占位，其余照常出图（不再整组失败）', async function () {
		this.timeout(15000);
		const root = makeRoot('grid-broken-');
		const files = await seedColored(path.join(root, 'imgs'));
		const outDir = path.join(root, 'out');
		fs.mkdirSync(outDir);
		const cells = files.map((fp, i) => ({
			code: `L${String(i + 1).padStart(3, '0')}`,
			img: i === 4 ? path.join(root, 'imgs', '这一张不存在.png') : fp,
		}));

		// 关键：以前这里是抛出去 → 整组白跑；现在必须照常出图
		const out = await renderLiveGrid(cells, outDir, 1, 'none');

		const { at } = await sampleCells(out);
		assert.ok(
			near(at(4), { r: 214, g: 214, b: 214 }, 30),
			`读不到的那格应该是灰底占位（#d6d6d6），实际 ${JSON.stringify(at(4))}`,
		);
		assert.ok(near(at(0), COLORS[0]), '前后的好格子必须照常出图');
		assert.ok(near(at(8), COLORS[8]), '最后一格也要在（并发下最容易漏的就是它）');
	});

	test('星标总览：并发读图后各格仍按排版位置归位', async function () {
		this.timeout(15000);
		const root = makeRoot('star-order-');
		const files = await seedColored(path.join(root, 'imgs'));
		const rows = files.map((fp, i) => ({
			code: `L${String(i + 1).padStart(3, '0')}`,
			img: fp,
			price: 100 + i,
			costPrice: 50 + i,
		}));

		// 标签全关 → 不压文字，采样点只剩纯色
		const labels = { code: false, costPrice: false, salePrice: false, fontSize: 0 };
		const buf = await renderStarOverviewBuffer(rows, 3, 3, labels);
		const out = path.join(root, 'overview.jpg');
		fs.writeFileSync(out, buf);

		const { at, info } = await sampleCells(out);
		assert.strictEqual(info.width, 900);
		for (let i = 0; i < 9; i++) {
			assert.ok(
				near(at(i), COLORS[i]),
				`第 ${i + 1} 格应该是第 ${i + 1} 张图，实际采到 ${JSON.stringify(at(i))}`,
			);
		}
	});
});

/**
 * 网页版的前提：整条后端导入链必须能在**没有 vscode** 的 Node 进程里加载。
 * 光靠"记得别 import"必然烂，所以钉两条：
 *   ① 源码层面：`src/tools/shopTool` 下（含 handlers）不许出现 `from "vscode"`；
 *   ② 产物层面：编译出来的 `out/tools/shopTool` 里不许出现 `require("vscode")`
 *      —— 这条更硬：`import type` 有没有被正确抹掉，只有看产物才知道。
 * 注意第 ② 条不能改成"真加载一遍"：测试跑在扩展宿主里，`vscode` 是可解析的，加载永远成功。
 */
suite('分层：shopTool 后端不依赖 vscode（网页版的前提）', () => {
	test('源码与编译产物里都没有 vscode 依赖', () => {
		const srcRoot = path.join(__dirname, '..', '..', 'src', 'tools', 'shopTool');
		const outRoot = path.join(__dirname, '..', 'tools', 'shopTool');
		const walk = (dir: string, ext: string): string[] => {
			const acc: string[] = [];
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const fp = path.join(dir, e.name);
				if (e.isDirectory()) {
					acc.push(...walk(fp, ext));
				} else if (e.name.endsWith(ext)) {
					acc.push(fp);
				}
			}
			return acc;
		};
		const hits = (root: string, ext: string, re: RegExp): string[] =>
			walk(root, ext)
				.filter((fp) => re.test(fs.readFileSync(fp, 'utf-8')))
				.map((fp) => path.relative(root, fp));

		assert.deepStrictEqual(
			hits(srcRoot, '.ts', /from\s+["']vscode["']/),
			[],
			'这些源文件还在 import vscode —— 会把网页服务端一起拖垮（那里没有 vscode 模块）',
		);
		assert.deepStrictEqual(
			hits(outRoot, '.js', /require\(["']vscode["']\)/),
			[],
			'这些编译产物还在 require vscode —— 检查是不是漏了 import type，或新加了直接调用',
		);
	});
});
