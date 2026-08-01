import type {
  BackendDescriptor,
  MusicBackendStatusResponse,
  MusicSearchResponse,
  MusicSearchTrack,
} from "$lib/protocol";
import { musicBackendErrorNotice } from "../music-errors";
import { MusicClient, MusicClientError } from "./music-client";

const STATUS_TTL_MS = 30_000;
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_LIMIT = 24;
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_BATCH_SIZE = 100;
const SEARCH_BATCH_PREFETCH_OFFSET = 40;
const INDICATOR_DEFAULT_DELAY_MS = 200;
const INDICATOR_MIN_DELAY_MS = 120;
const INDICATOR_MAX_DELAY_MS = 600;
const LATENCY_SMOOTHING = 0.25;

/**
 * 请求耗时的滑动估计，决定「多久没返回才显示骨架屏」。
 *
 * 依据 NN/g 与 Material 3 的结论：快请求（<1s）出现加载指示只会让用户焦虑，
 * 因此指示的出现必须晚于该后端「正常」的响应时间。这里借用 TCP RTO 的
 * Jacobson/Karels 算法，用 均值 + 2×偏差 刻画正常波动上限：
 * 历史响应越快，延迟越短（快后端几乎永远不显示骨架）；
 * 历史波动越大，延迟越长（避免抖动请求把骨架屏闪出来）。
 */
export class LatencyEstimator {
  private mean: number | undefined;
  private deviation = 0;

  add(sampleMs: number): void {
    if (this.mean === undefined) {
      this.mean = sampleMs;
      this.deviation = sampleMs / 2;
      return;
    }
    const error = sampleMs - this.mean;
    this.mean += LATENCY_SMOOTHING * error;
    this.deviation += LATENCY_SMOOTHING * (Math.abs(error) - this.deviation);
  }

  get indicatorDelayMs(): number {
    if (this.mean === undefined) return INDICATOR_DEFAULT_DELAY_MS;
    return Math.min(
      INDICATOR_MAX_DELAY_MS,
      Math.max(INDICATOR_MIN_DELAY_MS, Math.round(this.mean + 2 * this.deviation)),
    );
  }
}

/**
 * 「延迟出现 + 最短停留」的加载指示状态机。
 *
 * arm() 之后 delayMs 内任务完成（disarm），指示永不出现——快操作零感知；
 * 指示一旦出现，至少停留 minVisibleMs 才允许消失，避免闪一下的二次闪烁。
 * 首屏骨架与后台续页骨架共用这一状态机。
 */
export class DeferredIndicator {
  visible = $state(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shownAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly minVisibleMs = 300,
  ) {}

  arm(delayMs: number, onShow?: () => void): void {
    this.clearTimer();
    if (this.visible) {
      onShow?.();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.visible = true;
      this.shownAt = this.now();
      onShow?.();
    }, delayMs);
  }

  disarm(onHide?: () => void): void {
    this.clearTimer();
    if (!this.visible) {
      onHide?.();
      return;
    }
    const remaining = this.minVisibleMs - (this.now() - this.shownAt);
    if (remaining <= 0) {
      this.visible = false;
      onHide?.();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.visible = false;
      onHide?.();
    }, remaining);
  }

  /** 立即隐藏并取消定时器（上下文切换时使用，不受最短停留约束）。 */
  reset(): void {
    this.clearTimer();
    this.visible = false;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

interface SearchCacheEntry {
  readonly response: MusicSearchResponse;
  readonly at: number;
}

function searchErrorNotice(error: unknown): string {
  if (error instanceof MusicClientError) {
    if (error.stage === "server" && error.code !== undefined) {
      return musicBackendErrorNotice(error.code);
    }
    if (error.stage === "transport") return "网络异常，请稍后重试";
    return "音乐服务响应异常，请稍后重试";
  }
  return "搜索失败，请稍后重试";
}

/**
 * 音乐管理弹窗的数据层：状态与搜索结果的缓存、防抖、竞态与自适应加载指示。
 *
 * 加载策略（NN/g「<1s 不应显示循环动画」+ Luke Wroblewski 骨架屏 + M3 增量加载）：
 * - 缓存命中：立即渲染，新鲜缓存零网络，过期缓存 stale-while-revalidate；
 * - 缓存未命中：延迟 LatencyEstimator.indicatorDelayMs 后才允许骨架屏出现，
 *   在延迟内完成的请求用户完全无感知；骨架一旦出现至少停留 INDICATOR_MIN_VISIBLE_MS；
 * - 第一页返回即渲染，随后静默续页到 100 条；慢续页才在列表尾部显示预测骨架；
 * - 已有内容时重新搜索不清空列表，布局保持稳定。
 */
export class MusicLibrary {
  status = $state<MusicBackendStatusResponse | undefined>(undefined);
  statusFailed = $state(false);

  tracks = $state<ReadonlyArray<MusicSearchTrack>>([]);
  total = $state(0);
  /** 当前列表对应的搜索词，空串表示尚未搜索 */
  resultQuery = $state("");
  searching = $state(false);
  firstPageLoading = $state(false);
  searchError = $state<string | undefined>(undefined);

  readonly latency = new LatencyEstimator();
  /** 自适应延迟 + 最短停留双阈值控制，分别驱动首屏与后台续页骨架 */
  private readonly indicator = new DeferredIndicator(() => this.now());
  private readonly moreIndicator = new DeferredIndicator(() => this.now());
  private readonly searchCache = new Map<string, SearchCacheEntry>();
  private statusFetchedAt = 0;
  private statusPromise: Promise<void> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private abortController: AbortController | undefined;
  private activeQuery: string | undefined;
  private nextPage: number | null = null;
  private resultTarget = SEARCH_BATCH_SIZE;
  private nextLoadThreshold = SEARCH_BATCH_SIZE - SEARCH_BATCH_PREFETCH_OFFSET;
  /** 最近一次实际发起的搜索词（含失败的），供重试使用 */
  private lastAttemptedQuery = "";
  private disposed = false;

  constructor(
    private readonly client: MusicClient,
    private readonly now: () => number = Date.now,
  ) {}

  static fromDescriptor(descriptor: BackendDescriptor): MusicLibrary {
    return new MusicLibrary(MusicClient.fromDescriptor(descriptor));
  }

  /**
   * 空闲预热（如设置菜单打开时）：服务端 WBI/会员状态本就有缓存，
   * 提前拉取让首次打开弹窗大概率直接命中，完全跳过加载态。
   */
  warm(): void {
    if (this.status !== undefined || this.statusPromise !== undefined) return;
    void this.refreshStatus();
  }

  /** 打开弹窗时调用：TTL 内直接用缓存，否则后台刷新。 */
  ensureStatus(): void {
    if (this.status !== undefined && this.now() - this.statusFetchedAt < STATUS_TTL_MS) return;
    void this.refreshStatus();
  }

  get showSkeleton(): boolean {
    return this.indicator.visible;
  }

  get showMoreSkeleton(): boolean {
    return this.moreIndicator.visible;
  }

  get moreSkeletonCount(): number {
    if (!this.moreIndicator.visible) return 0;
    const remaining = Math.min(this.resultTarget, this.total) - this.tracks.length;
    return Math.max(0, remaining);
  }

  retryStatus(): void {
    this.statusFailed = false;
    void this.refreshStatus();
  }

  /** 输入变化：防抖后搜索；清空输入立即复位到提示态。 */
  requestSearch(rawQuery: string): void {
    const query = rawQuery.trim();
    this.clearDebounceTimer();
    if (query.length === 0) {
      this.cancelSearch();
      this.resultQuery = "";
      this.tracks = [];
      this.total = 0;
      this.searchError = undefined;
      return;
    }
    if (query === this.resultQuery && this.searchError === undefined) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.search(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  /** 立即搜索（回车），跳过防抖。 */
  searchNow(rawQuery: string): void {
    this.clearDebounceTimer();
    const query = rawQuery.trim();
    if (query.length === 0) return;
    void this.search(query);
  }

  /** 浏览到当前批次后 40 条前时，静默预取下一批 100 条。 */
  loadMoreWhenVisible(visibleTrackCount: number): void {
    const query = this.activeQuery;
    const abort = this.abortController;
    if (
      this.disposed ||
      this.searching ||
      this.searchError !== undefined ||
      this.nextPage === null ||
      query === undefined ||
      abort === undefined ||
      visibleTrackCount < this.nextLoadThreshold
    ) {
      return;
    }
    this.resultTarget += SEARCH_BATCH_SIZE;
    this.nextLoadThreshold += SEARCH_BATCH_SIZE;
    this.searching = true;
    this.moreIndicator.arm(this.latency.indicatorDelayMs);
    void this.loadNextBatch(query, abort);
  }

  /** 重试最近一次搜索（失败时结果为空，需用尝试过的搜索词）。 */
  retry(): void {
    const query = this.lastAttemptedQuery || this.resultQuery;
    if (query.length > 0) void this.search(query);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelSearch();
  }

  private async refreshStatus(): Promise<void> {
    if (this.statusPromise !== undefined) return this.statusPromise;
    this.statusPromise = (async () => {
      try {
        const status = await this.client.readStatus();
        if (this.disposed) return;
        this.status = status;
        this.statusFailed = false;
        this.statusFetchedAt = this.now();
      } catch {
        if (!this.disposed) this.statusFailed = true;
      } finally {
        this.statusPromise = undefined;
      }
    })();
    return this.statusPromise;
  }

  private async search(query: string): Promise<void> {
    if (this.disposed) return;
    if (this.searching && query === this.activeQuery) return;
    this.abortController?.abort();
    const abort = new AbortController();
    this.abortController = abort;
    this.activeQuery = query;
    this.lastAttemptedQuery = query;
    this.searchError = undefined;
    this.firstPageLoading = true;
    this.moreIndicator.reset();

    const cached = this.readCache(query);
    if (cached !== undefined) {
      this.applyCachedResult(query, cached.response);
      if (this.now() - cached.at < SEARCH_CACHE_TTL_MS) {
        this.searching = false;
        this.firstPageLoading = false;
        this.disarmIndicator();
        return;
      }
    } else {
      this.resultTarget = SEARCH_BATCH_SIZE;
      this.nextLoadThreshold = SEARCH_BATCH_SIZE - SEARCH_BATCH_PREFETCH_OFFSET;
      this.nextPage = null;
    }

    this.searching = true;
    this.armIndicator(cached !== undefined || this.tracks.length > 0);
    try {
      const response = await this.requestPage(query, 1, abort.signal);
      if (this.disposed || abort.signal.aborted) return;
      this.applyFirstPage(query, response);
      this.firstPageLoading = false;
      this.disarmIndicator();
      if (this.nextPage !== null && this.tracks.length < this.resultTarget) {
        this.moreIndicator.arm(this.latency.indicatorDelayMs);
        await this.loadPagesToTarget(query, abort);
      }
      if (this.disposed || abort.signal.aborted) return;
      this.completeSearch(query);
    } catch (error) {
      this.failSearch(error, abort);
    }
  }

  private async loadNextBatch(query: string, abort: AbortController): Promise<void> {
    try {
      await this.loadPagesToTarget(query, abort);
      if (this.disposed || abort.signal.aborted) return;
      this.completeSearch(query);
    } catch (error) {
      this.failSearch(error, abort);
    }
  }

  private async loadPagesToTarget(query: string, abort: AbortController): Promise<void> {
    while (this.nextPage !== null && this.tracks.length < this.resultTarget) {
      const page = this.nextPage;
      const response = await this.requestPage(query, page, abort.signal);
      if (this.disposed || abort.signal.aborted) return;
      this.appendPage(response, page);
    }
  }

  private async requestPage(
    query: string,
    page: number,
    signal: AbortSignal,
  ): Promise<MusicSearchResponse> {
    const started = this.now();
    const response = await this.client.search({ query, page }, signal);
    this.latency.add(this.now() - started);
    return response;
  }

  private applyCachedResult(query: string, response: MusicSearchResponse): void {
    this.resultQuery = query;
    this.tracks = response.tracks;
    this.total = response.total;
    this.nextPage = response.nextPage ?? null;
    const loadedBatches = Math.max(1, Math.ceil(this.tracks.length / SEARCH_BATCH_SIZE));
    this.resultTarget = loadedBatches * SEARCH_BATCH_SIZE;
    this.nextLoadThreshold = this.resultTarget - SEARCH_BATCH_PREFETCH_OFFSET;
  }

  private applyFirstPage(query: string, response: MusicSearchResponse): void {
    this.resultQuery = query;
    this.tracks = response.tracks.slice(0, this.resultTarget);
    this.total = response.total;
    this.nextPage = this.pageAfter(response, 1);
  }

  private appendPage(response: MusicSearchResponse, page: number): void {
    const seen = new Set(this.tracks.map((track) => track.bvid));
    const tracks = [...this.tracks];
    for (const track of response.tracks) {
      if (tracks.length >= this.resultTarget) break;
      if (seen.has(track.bvid)) continue;
      seen.add(track.bvid);
      tracks.push(track);
    }
    this.tracks = tracks;
    this.total = Math.max(this.total, response.total);
    this.nextPage = this.pageAfter(response, page);
  }

  private pageAfter(response: MusicSearchResponse, currentPage: number): number | null {
    const nextPage = response.nextPage;
    return nextPage !== undefined && nextPage !== null && nextPage > currentPage
      ? nextPage
      : null;
  }

  private completeSearch(query: string): void {
    this.searching = false;
    this.firstPageLoading = false;
    this.disarmIndicator();
    this.moreIndicator.disarm();
    this.writeCache(query, {
      total: this.total,
      tracks: this.tracks,
      nextPage: this.nextPage,
    });
  }

  private failSearch(error: unknown, abort: AbortController): void {
    if (this.disposed || abort.signal.aborted) return;
    this.searching = false;
    this.firstPageLoading = false;
    this.disarmIndicator();
    this.moreIndicator.disarm();
    this.searchError = searchErrorNotice(error);
  }

  private cancelSearch(): void {
    this.clearDebounceTimer();
    this.abortController?.abort();
    this.abortController = undefined;
    this.activeQuery = undefined;
    this.nextPage = null;
    this.resultTarget = SEARCH_BATCH_SIZE;
    this.nextLoadThreshold = SEARCH_BATCH_SIZE - SEARCH_BATCH_PREFETCH_OFFSET;
    this.searching = false;
    this.firstPageLoading = false;
    this.indicator.reset();
    this.moreIndicator.reset();
  }

  private armIndicator(hasContent: boolean): void {
    if (hasContent) {
      // 已有内容时改用顶部细条提示，绝不清空列表
      this.indicator.reset();
      return;
    }
    this.indicator.arm(this.latency.indicatorDelayMs);
  }

  private disarmIndicator(): void {
    this.indicator.disarm();
  }

  private readCache(query: string): SearchCacheEntry | undefined {
    const entry = this.searchCache.get(query);
    if (entry !== undefined) {
      // LRU：命中即提为最新
      this.searchCache.delete(query);
      this.searchCache.set(query, entry);
    }
    return entry;
  }

  private writeCache(query: string, response: MusicSearchResponse): void {
    this.searchCache.delete(query);
    this.searchCache.set(query, { response, at: this.now() });
    while (this.searchCache.size > SEARCH_CACHE_LIMIT) {
      const oldest = this.searchCache.keys().next();
      if (oldest.done === true) break;
      this.searchCache.delete(oldest.value);
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }
}
