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
};

/** 已经编好号、编好文本的事件（环形缓冲里存的就是它） */
export type SseFrame = {
  id: number;
  event: string;
  data: string;
  origin: string;
};

/** 环形缓冲默认留多少条：手机锁屏几分钟再回来还能补上，代价也就几十 KB */
const DEFAULT_KEEP = 200;

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
   * 广播一条。
   *
   * **先留档、再扇出**：留档是为了断线续传；扇出失败（那个客户端已经走了）只影响它自己，
   * 绝不能让 publish 抛出去——调用方是正在写日志的后台任务，这里抛一嗓子等于把整个
   * 生成任务弄挂。
   *
   * 与发信人同源的连接会跳过：他自己那次 `/api/invoke` 的响应里已经带回同样一份，
   * 再推一遍就是「同一件事应用两遍」。
   */
  publish(e: HubEvent): SseFrame {
    const origin = e.origin || "";
    const frame: SseFrame = {
      id: this.nextId++,
      event: e.event,
      data: typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? null),
      origin,
    };
    this.buffer.push(frame);
    if (this.buffer.length > this.keep) {
      this.buffer.splice(0, this.buffer.length - this.keep);
    }
    const text = formatFrame(frame);
    for (const c of [...this.clients]) {
      if (origin && c.origin === origin) {
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
      this.send(sink, formatFrame({ id: 0, event: "reset", data: "{}", origin: "" }));
      return;
    }
    for (const f of this.buffer) {
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
