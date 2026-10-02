/**
 * 一条串行的队列（并发 = 1）。纯逻辑、不认识 http，所以能直接被 node 脚本测。
 *
 * 为什么服务端需要它（docs/网页版方案-设计.md §十、§M2）：
 *
 * 1. **写请求串行化。** 网页版是多人并发：两个手机同时点保存，两个请求会交错着进
 *    `handleMessage`。库又在共享盘上（`journal_mode = DELETE`，见 db.ts），SQLite 那边
 *    本来就是"一个写、别人等" —— 服务端先把自己管住，别去凑那个热闹。
 * 2. **重活任务排队**（生成共享缩略图 / 九宫格）：同一时刻只跑一个，别让两个人同时点
 *    把 CPU 和共享盘打满。
 *
 * 语义上是"排队"而不是"限流"：进队的任务**一定**会跑。前面那个抛错也只影响它自己
 * （错误沿它自己的 Promise 出去），后面排队的照跑 —— 这一点最要紧：一个用户输入出错
 * 不能把别人的保存卡死。
 */
export class SerialQueue {
  /** 链尾。永远是一个"已解决"的 Promise，所以失败不会传染给后面排队的 */
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private active = 0;

  constructor(private readonly label = "队列") {}

  /** 还没跑完的几个（含正在跑的那个）：给界面显示「前面还有 N 个」 */
  get depth(): number {
    return this.active + this.waiting;
  }

  get busy(): boolean {
    return this.active > 0;
  }

  get name(): string {
    return this.label;
  }

  /** 排队执行。返回的 Promise 就是这次任务本身的结果（成功/失败都照原样给调用方） */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    this.waiting++;
    const start = (): Promise<T> => {
      this.waiting--;
      this.active++;
      return Promise.resolve()
        .then(task)
        .finally(() => {
          this.active--;
        });
    };
    const result = this.tail.then(start, start);
    // 链尾吞掉成败：只用来"接下一个"，不代表任务结果（结果已经由 result 给调用方了）
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
