import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { liveHandlers } from '../tools/shopTool/handlers/live.js';
import { imageHandlers } from '../tools/shopTool/handlers/image.js';
import { settingsHandlers } from '../tools/shopTool/handlers/settings.js';
import { HandlerCtx } from '../tools/shopTool/handlers/types.js';
import { ToolContext } from '../core/toolContext.js';
import { LOCAL_PREF_KEYS } from '../tools/shopTool/index.js';

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
			post: () => undefined,
			postLiveState: () => undefined,
		} as unknown as HandlerCtx;
		const msg = { plan: [{ group_no: 1, slot_no: 1, code: 'A001' }] };

		return {
			run: () => liveHandlers(h).generateLiveGrid(msg, h),
			settings,
			prefs,
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
		assert.strictEqual(harness.prefs.get('live_out_dir'), dir);
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
		assert.strictEqual(harness.prefs.get('live_out_dir'), nextDir);
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
		assert.strictEqual(harness.prefs.get('live_out_dir'), nextDir);
	});

	// 共享盘上「全组一份、最后改的人覆盖所有人」就是这么来的：
	// 输出目录是别人机器上的路径，存进 settings 表就等于把它推给全组。
	test('输出目录只写本机，绝不写共享库', async () => {
		const dir = makeDir('local-only');
		const harness = createHarness({ pickDirs: [dir], actions: ['取消'] });

		await harness.run();

		assert.strictEqual(harness.prefs.get('live_out_dir'), dir);
		assert.strictEqual(harness.settings.has('live_out_dir'), false);
	});

	test('只读模式下不落库（排品不写共享库，出图流程照走）', async () => {
		const dir = makeDir('ro');
		let replaceLivePlanCalls = 0;
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
			post: () => undefined,
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

	test('取消选择目录时不打开确认框', async () => {
		const harness = createHarness({ pickDirs: [undefined], actions: ['取消'] });

		await harness.run();

		assert.strictEqual(harness.selectCount, 1);
		assert.deepStrictEqual(harness.confirmedDirs, []);
		assert.strictEqual(harness.prefs.has('live_out_dir'), false);
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
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cherysis-img-'));
		roots.push(root);
		return root;
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
			panel: { webview: { asWebviewUri: (u: vscode.Uri) => u } },
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
			fs.rmSync(root, { recursive: true, force: true });
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

	test('文件被占用时会退避重试，重试成功即算删掉', async () => {
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

	test('重试到底仍被占用：说清是占用，并把磁盘现状推回前端', async () => {
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
		assert.strictEqual(harness.loadAllCount, 1);
	});

	test('非占用类错误不重试，直接报原始信息', async () => {
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

	test('清空图片夹：部分删不掉时报实际张数，不谎报「已清空」', async () => {
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
	});
});
