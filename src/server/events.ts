/**
 * 网页版的实时推送中枢（设计稿 docs/网页版方案-设计.md §4.2 的 SSE /events）。
 *
 * 为什么要有它：`/api/invoke` 是「一问一答」——每次请求现建一个宿主，把 posts/logs 收进
 * 本次请求的数组再回给浏览器（见 index.ts 的 invoke）。这套在**后台任务**面前是漏的：
 * `handlers/image.ts` 的 buildSharedThumbs 是刻意不 await 的（上千张图要跑几分钟，卡在
 * handler 里会把整个面板的消息堵在后面），等它写日志时响应早就发出去了，那些字就掉在地上。
 * 实时推送就是给它们一个出口。
 *
 * 这一层刻意**不认识 http**：只做「编号、留档、扇出」三件事；传输细节（响应头、心跳、
 * 断线重连、token）留在 src/server/index.ts 的 /api/events 路由里。这样测试里拿个假对象
 * 就能把语义全跑一遍（见 scripts/check-server-units.cjs），不用起服务、不碰真库。
 */

/** 一个订阅者。只要「能收一段文本」——所以测试里的假对象也能当订阅者 */
export interface SseSink {
  /** 谁连上来的（浏览器 localStorage 里的 clientId）：用来跳过自己发的消息 */
  readonly origin: string;
  write(chunk: string): unknown;
  end(): void;
}

/** 往中枢里投的一条事件 */
export type HubEvent = {
  /** 事件名：log / toast / post / changed / queue / progress / reset */
  event: string;
  data: unknown;
  /** 谁引起的；空串（或省略）= 服务端自己（定时巡检、后台任务） */
  origin?: string;
  /**
   * **只发给这一个连接**（浏览器 clientId）。空串（或省略）= 广播。
   *
   * 为什么要有它：长任务的「一次性结果」（导出的 Excel 字节、生成的九宫格文件名）
   * 只对点按钮的那台设备有意义。以前走广播 → 手机上点导出，**电脑那台也跟着下载一份**，
   * 而且那张表转成 base64 有一两 MB，等于白推给每台设备。
   * 加了 target 之后：只有点的那个人收，其他人一条都看不到。
   */
  target?: string;
};

/** 已经编好号、编好文本的事件（环形缓冲里存的就是它） */
export type SseFrame = {
  id: number;
  event: string;
  data: string;
  origin: string;
  /** 空串 = 广播；非空 = 只该发给这个 clientId（见 HubEvent.target） */
  target: string;
};

/** 环形缓冲默认留多少条：手机锁屏几分钟再回来还能补上，代价也就几十 KB */
const DEFAULT_KEEP = 200;

/**
 * 这次写完了，该不该给所有人发一条 `changed`（让界面把「🔄 有改动」亮起来）？
 *
 * 规则只有一句：**看这次写有没有顺手回推给别人**。
 * - 有（`productsDelta` / `productsLoaded` 这类）→ 别人那边靠这条回推已经自动同步了，
 *   再发 changed 只会让人没事就看到「有改动」，久了就没人信那个角标了；
 * - 没有 → 别人毫无知觉，必须提醒，否则他会拿着一份过期的数据继续改。
 *
 * 而"到底写进库没有"由库文件指纹判定（见 index.ts 的 dbFingerprint）：handler 内部把
 * 业务错误吞掉只记日志，"没抛异常"和"写了"是两回事 —— 比如改了不存在的商品。
 *
 * 单独拎出来是因为这段判断**测不到就别扭**：真机上要凑出"写成功且一条回推都没有"的场景
 * 得翻遍所有 handler，而它错了的后果（悄悄不提示）又几乎不可能被发现。
 */
export function shouldAnnounceChange(wrote: boolean, postCount: number): boolean {
  return wrote && postCount === 0;
}

/**
 * 按 SSE 线格式编帧。
 * `data:` 是**按行**的协议：JSON 里带换行的字符串必须一行一个 `data:`，
 * 否则浏览器按第一个换行截断，前端拿到的就是半个 JSON。
 */
export function formatFrame(f: SseFrame): string {
  const lines = f.data.split(/\r?\n/).map((l) => `data: ${l}`);
  return `id: ${f.id}\nevent: ${f.event}\n${lines.join("\n")}\n\n`;
}

export class EventHub {
  private nextId = 1;
  private readonly buffer: SseFrame[] = [];
  private readonly clients = new Set<SseSink>();

  constructor(private readonly keep: number = DEFAULT_KEEP) {}

  /** 当前连着几个：报在 /api/ping 里，排查「手机到底连上没有」用 */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * 广播一条（或：只发给 target 那一个）。
   *
   * **先留档、再扇出**：留档是为了断线续传；扇出失败（那个客户端已经走了）只影响它自己，
   * 绝不能让 publish 抛出去——调用方是正在写日志的后台任务，这里抛一嗓子等于把整个
   * 生成任务弄挂。
   *
   * 两种去向，规则不同：
   * - **广播**（没有 target）：跳过与发信人同源的连接 —— 他自己那次 `/api/invoke` 的响应里
   *   已经带回同样一份，再推一遍就是「同一件事应用两遍」。
   * - **定向**（有 target）：**只发给 target 那一个，而且不跳过 origin** —— 因为发起者本人
   *   正是唯一该收到的人（长任务脱钩后 origin 已经清空了，靠 origin 判断根本判不出来）。
   *
   * ⚠️ 定向帧**不进环形缓冲**：它只对一个人有意义，补发给别人是噪音；更要紧的是导出那种
   *    帧里带着整张表（base64 一两 MB），缓冲留 200 条能直接把内存顶爆。
   *    代价：定向结果断线后补不回来 —— 那种结果本来就是"再点一次"最省事。
   */
  publish(e: HubEvent): SseFrame {
    const origin = e.origin || "";
    const target = e.target || "";
    const frame: SseFrame = {
      id: this.nextId++,
      event: e.event,
      data: typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? null),
      origin,
      target,
    };
    if (!target) {
      this.buffer.push(frame);
      if (this.buffer.length > this.keep) {
        this.buffer.splice(0, this.buffer.length - this.keep);
      }
    }
    const text = formatFrame(frame);
    for (const c of [...this.clients]) {
      if (target) {
        if (c.origin !== target) {
          continue;
        }
      } else if (origin && c.origin === origin) {
        continue;
      }
      this.send(c, text);
    }
    return frame;
  }

  /** 挂一个订阅者，返回「摘掉」的函数（在请求的 close 事件里调） */
  attach(sink: SseSink): () => void {
    this.clients.add(sink);
    return () => {
      this.clients.delete(sink);
    };
  }

  /**
   * 断线续传：把 id > lastId 的补发一遍（浏览器 EventSource 重连时会带 Last-Event-ID）。
   *
   * - `lastId <= 0`：全新连接，没有断点，一条都不补（补了就是白白推一堆旧事件）。
   * - `lastId` 比缓冲里最旧那条还小：断太久、中间那段已经丢了 —— 发一条 reset 让前端
   *   整表重读，而不是让它拿着"缺一段"的数据继续用（少一段数据比多刷一次更糟）。
   */
  replay(sink: SseSink, lastId: number): void {
    if (!(lastId > 0)) {
      return;
    }
    const oldest = this.buffer.length > 0 ? this.buffer[0].id : this.nextId;
    if (lastId < oldest - 1) {
      this.send(sink, formatFrame({ id: 0, event: "reset", data: "{}", origin: "", target: "" }));
      return;
    }
    for (const f of this.buffer) {
      // 缓冲里只可能是广播（定向帧压根不入缓冲，见 publish 的注释）；
      // 这条判断是防"以后有人改了"的兜底：别人的定向结果永远不该补发给我。
      if (f.target && f.target !== sink.origin) {
        continue;
      }
      if (f.id > lastId) {
        this.send(sink, formatFrame(f));
      }
    }
  }

  /** 停机时把连接收干净（不然浏览器要一直等到超时才知道断了） */
  closeAll(): void {
    for (const c of [...this.clients]) {
      try {
        c.end();
      } catch {
        /* 对面已经断了，正常 */
      }
    }
    this.clients.clear();
  }

  /** 写失败的订阅者直接摘掉：手机锁屏/切后台时连接会半死，留着只会每次广播都报一次错 */
  private send(sink: SseSink, text: string): void {
    try {
      sink.write(text);
    } catch {
      this.clients.delete(sink);
    }
  }
}
