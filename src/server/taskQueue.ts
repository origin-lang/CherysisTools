import { SerialQueue } from "./serialQueue.js";

/**
 * 服务端的"重活队列"：同一时刻只跑一个要跑几分钟的任务
 * （生成共享缩略图 / 生成九宫格），别的进来排队。
 *
 * 为什么要有它（docs/网页版方案-设计.md §十、§M2）：这些活儿要么把 CPU 打满、要么把共享盘
 * 读爆。VS Code 版各人一台机器，两个人同时点是各占各的资源；网页版只有一个服务进程，
 * 两个人同时点就是**同一个进程、同一个共享盘**上叠两倍负载 —— 谁都快不了，还可能把
 * SMB 带宽抢光，连累正在保存的人。
 *
 * 这一层不懂"任务是什么"，只管排队与报状态：真正干什么由调用方给的工厂决定。
 * `run` 是**工厂**而不是已经开始的 Promise（重要）：排队期间一个字节都不该去读共享盘，
 * 否则"排队"就成了摆设。
 *
 * 状态变化通过 onChange 广播出去（服务端把它转成 SSE 的 queue 事件），
 * 这样手机上能看见"正在生成 X / 前面还有 N 个"，而不是点了没反应。
 */
export type TaskQueueStatus = {
  /** 正在跑的那个任务名；空串 = 队列闲着 */
  running: string;
  /** 排队等着的有哪些（按先后） */
  waiting: string[];
};

export class TaskQueue {
  private readonly serial: SerialQueue;
  private running = "";
  private waiting: string[] = [];
  private readonly listeners = new Set<(s: TaskQueueStatus) => void>();

  /**
   * @param onError 任务自己没兜住的错误。任务通常自带 try/catch（要发终态给前端），
   *   这里只是最后一道，别让一个错误把队列卡死。
   */
  constructor(private readonly onError: (name: string, err: unknown) => void = () => undefined) {
    this.serial = new SerialQueue("重活队列");
  }

  status(): TaskQueueStatus {
    return { running: this.running, waiting: [...this.waiting] };
  }

  /** 前面还有几个（含正在跑的那个） */
  get depth(): number {
    return this.serial.depth;
  }

  /** 订阅状态变化，返回退订函数 */
  onChange(fn: (s: TaskQueueStatus) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 排队。立刻返回；任务真正跑起来时（可能过一会儿）才调 run() */
  enqueue(name: string, run: () => Promise<void>): void {
    this.waiting.push(name);
    this.notify();
    void this.serial
      .run(async () => {
        // 同名任务可能排了不止一个，出队时按名字摘掉最早的那一个就够了
        const i = this.waiting.indexOf(name);
        if (i >= 0) {
          this.waiting.splice(i, 1);
        }
        this.running = name;
        this.notify();
        try {
          await run();
        } catch (err) {
          this.onError(name, err);
        } finally {
          this.running = "";
          this.notify();
        }
      })
      .catch(() => undefined); // 上面已经兜过，这里只是别让 Promise 悬着
  }

  private notify(): void {
    const s = this.status();
    for (const fn of [...this.listeners]) {
      try {
        fn(s);
      } catch {
        /* 一个订阅者出问题不该影响队列本身 */
      }
    }
  }
}
