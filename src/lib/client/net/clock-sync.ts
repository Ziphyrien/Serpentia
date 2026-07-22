/**
 * 服务端时钟同步：用 welcome/pong 的 serverTime 估算
 * 「服务端现在几点」，供插值与预测对齐使用。
 */
export class ClockSync {
  private offsetMs: number | undefined;
  private bestRttMs = Number.POSITIVE_INFINITY;

  /** 粗略初始化（连接刚建立时）。 */
  seed(serverTime: number): void {
    if (this.offsetMs === undefined) {
      this.offsetMs = serverTime - Date.now();
    }
  }

  /** 用一次 ping/pong 样本精化偏移。 */
  sample(nonceSentAt: number, serverTime: number): number {
    const now = Date.now();
    const rtt = Math.max(0, now - nonceSentAt);
    const offset = serverTime - (nonceSentAt + rtt / 2);
    if (this.offsetMs === undefined) {
      this.offsetMs = offset;
    } else if (rtt <= this.bestRttMs * 1.5 + 20) {
      // 只在 RTT 不劣化时平滑收敛，避免抖动污染
      this.offsetMs = this.offsetMs * 0.8 + offset * 0.2;
    }
    this.bestRttMs = Math.min(this.bestRttMs, rtt);
    return rtt;
  }

  /** 估算的服务端当前时间（毫秒）。未同步前返回 undefined。 */
  serverNow(): number | undefined {
    return this.offsetMs === undefined ? undefined : Date.now() + this.offsetMs;
  }

  get rttMs(): number {
    return this.bestRttMs === Number.POSITIVE_INFINITY ? 0 : this.bestRttMs;
  }
}
