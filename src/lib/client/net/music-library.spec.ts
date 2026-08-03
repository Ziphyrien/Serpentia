import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MusicClient } from "./music-client";
import { DeferredIndicator, LatencyEstimator, MusicLibrary } from "./music-library.svelte";

const REFERENCE = "signed-reference-token-0123456789abcdef";

const STATUS = {
  source: "bilibili",
  available: true,
  qualities: ["64k", "132k", "192k"],
};

function makeTrack(bvid: string, title: string) {
  return {
    bvid,
    title,
    artist: "UP 主",
    durationSeconds: 180,
    pictureUrl: null,
    qualities: ["64k", "132k", "192k"],
    reference: `${REFERENCE}${bvid}`,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SearchHandler = (query: string, page: number) => unknown | Promise<unknown>;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function makeLibrary(handler: SearchHandler): MusicLibrary {
  const client = new MusicClient("/status", "/search", async (input, init) => {
    const url = requestUrl(input);
    if (url.endsWith("/status")) return Response.json(STATUS);
    const body = JSON.parse(String(init?.body)) as { query: string; page?: number };
    return Response.json(await handler(body.query, body.page ?? 1));
  });
  return new MusicLibrary(client);
}

/** 让 handler 在指定毫秒后才返回（由 fake timers 驱动）。 */
function respondAfter(ms: number, value: () => unknown): SearchHandler {
  return () =>
    new Promise((resolve) => {
      setTimeout(() => resolve(value()), ms);
    });
}

describe("LatencyEstimator", () => {
  it("defaults to 200ms before any sample", () => {
    expect(new LatencyEstimator().indicatorDelayMs).toBe(200);
  });

  it("shrinks the delay for consistently fast backends", () => {
    const estimator = new LatencyEstimator();
    for (let i = 0; i < 6; i += 1) estimator.add(40);
    expect(estimator.indicatorDelayMs).toBe(120);
  });

  it("grows with the mean and clamps at 600ms", () => {
    const estimator = new LatencyEstimator();
    for (let i = 0; i < 6; i += 1) estimator.add(1_000);
    expect(estimator.indicatorDelayMs).toBe(600);
  });

  it("tolerates jitter by including twice the deviation", () => {
    const estimator = new LatencyEstimator();
    for (const sample of [100, 300, 100, 300, 100, 300]) estimator.add(sample);
    expect(estimator.indicatorDelayMs).toBeGreaterThan(300);
  });
});

describe("DeferredIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays hidden when the task finishes inside the delay", async () => {
    const indicator = new DeferredIndicator();
    indicator.arm(150);
    await vi.advanceTimersByTimeAsync(100);
    indicator.disarm();
    await vi.advanceTimersByTimeAsync(500);
    expect(indicator.visible).toBe(false);
  });

  it("honors the minimum visible time once shown", async () => {
    const indicator = new DeferredIndicator();
    indicator.arm(150);
    await vi.advanceTimersByTimeAsync(150);
    expect(indicator.visible).toBe(true);
    indicator.disarm();
    await vi.advanceTimersByTimeAsync(299);
    expect(indicator.visible).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(indicator.visible).toBe(false);
  });

  it("hides immediately when the wait already exceeded the minimum", async () => {
    const indicator = new DeferredIndicator();
    indicator.arm(150);
    await vi.advanceTimersByTimeAsync(1_000);
    indicator.disarm();
    expect(indicator.visible).toBe(false);
  });

  it("reset hides immediately regardless of the minimum visible time", async () => {
    const indicator = new DeferredIndicator();
    indicator.arm(150);
    await vi.advanceTimersByTimeAsync(150);
    indicator.reset();
    expect(indicator.visible).toBe(false);
  });
});

describe("MusicLibrary adaptive loading", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never shows the skeleton when the response beats the delay", async () => {
    const library = makeLibrary(
      respondAfter(50, () => ({ total: 1, tracks: [makeTrack("BV1xx411c7mD", "Song A")] })),
    );
    library.searchNow("song");
    await vi.advanceTimersByTimeAsync(30);
    expect(library.showSkeleton).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    expect(library.showSkeleton).toBe(false);
    expect(library.tracks).toHaveLength(1);
    expect(library.searching).toBe(false);
  });

  it("shows the skeleton past the delay and hides it right after a long wait", async () => {
    const library = makeLibrary(
      respondAfter(1_000, () => ({ total: 1, tracks: [makeTrack("BV1xx411c7mD", "Song A")] })),
    );
    library.searchNow("song");
    await vi.advanceTimersByTimeAsync(199);
    expect(library.showSkeleton).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(library.showSkeleton).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(library.tracks).toHaveLength(1);
    expect(library.showSkeleton).toBe(false);
  });

  it("keeps the skeleton for the minimum visible time to avoid flicker", async () => {
    const library = makeLibrary(
      respondAfter(250, () => ({ total: 1, tracks: [makeTrack("BV1xx411c7mD", "Song A")] })),
    );
    library.searchNow("song");
    await vi.advanceTimersByTimeAsync(250);
    expect(library.showSkeleton).toBe(true);
    expect(library.tracks).toHaveLength(1);
    // 骨架在 200ms 出现，250ms 数据就绪；最短停留 300ms → 500ms 才隐藏
    await vi.advanceTimersByTimeAsync(249);
    expect(library.showSkeleton).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(library.showSkeleton).toBe(false);
  });

  it("adapts: after fast samples the skeleton appears earlier than the default", async () => {
    const library = makeLibrary(respondAfter(60, () => ({ total: 0, tracks: [] })));
    for (const query of ["a", "b", "c", "d", "e"]) {
      library.searchNow(query);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(library.latency.indicatorDelayMs).toBe(120);
  });

  it("renders page one immediately and prefetches subsequent 100-track batches", async () => {
    const requestedPages: Array<number> = [];
    const secondPage = deferred<unknown>();
    const responseForPage = (page: number) => {
      const firstIndex = (page - 1) * 20 + 1;
      return {
        total: 220,
        tracks: Array.from({ length: Math.min(20, 221 - firstIndex) }, (_, offset) => {
          const index = firstIndex + offset;
          return makeTrack(`BV${String(index).padStart(10, "0")}`, `Song ${index}`);
        }),
        nextPage: page < 11 ? page + 1 : null,
      };
    };
    const library = makeLibrary((_query, page) => {
      requestedPages.push(page);
      return page === 2 ? secondPage.promise : responseForPage(page);
    });

    library.searchNow("song");
    expect(library.firstPageLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(library.firstPageLoading).toBe(false);
    expect(library.tracks).toHaveLength(20);
    expect(library.searching).toBe(true);
    expect(requestedPages).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(119);
    expect(library.showMoreSkeleton).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(library.showMoreSkeleton).toBe(true);
    expect(library.moreSkeletonCount).toBe(80);

    secondPage.resolve(responseForPage(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(library.tracks).toHaveLength(100);
    expect(library.searching).toBe(false);
    expect(requestedPages).toEqual([1, 2, 3, 4, 5]);
    await vi.advanceTimersByTimeAsync(300);
    expect(library.showMoreSkeleton).toBe(false);

    library.loadMoreWhenVisible(59);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedPages).toHaveLength(5);
    library.loadMoreWhenVisible(60);
    await vi.advanceTimersByTimeAsync(0);
    expect(library.tracks).toHaveLength(200);
    expect(requestedPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    library.loadMoreWhenVisible(159);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedPages).toHaveLength(10);
    library.loadMoreWhenVisible(160);
    await vi.advanceTimersByTimeAsync(0);
    expect(library.tracks).toHaveLength(220);
    expect(requestedPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

describe("MusicLibrary search caching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a fresh cached query without any network request", async () => {
    let calls = 0;
    const library = makeLibrary(() => {
      calls += 1;
      return { total: 1, tracks: [makeTrack("BV1xx411c7mD", "Song A")] };
    });
    library.searchNow("song");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    library.searchNow("song");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(library.tracks).toHaveLength(1);
    expect(library.searching).toBe(false);
  });

  it("revalidates stale cache in the background while keeping old results visible", async () => {
    let version = 1;
    const library = makeLibrary(
      respondAfter(50, () => ({
        total: 1,
        tracks: [makeTrack("BV1xx411c7mD", `Song v${version}`)],
      })),
    );
    library.searchNow("song");
    await vi.advanceTimersByTimeAsync(60);
    expect(library.tracks[0]?.title).toBe("Song v1");

    version = 2;
    await vi.advanceTimersByTimeAsync(61_000);
    library.searchNow("song");
    // 过期缓存立即渲染，不进入骨架态
    expect(library.tracks[0]?.title).toBe("Song v1");
    expect(library.searching).toBe(true);
    expect(library.showSkeleton).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(library.tracks[0]?.title).toBe("Song v2");
    expect(library.searching).toBe(false);
  });

  it("keeps previous results and skips the skeleton while a new search is in flight", async () => {
    const library = makeLibrary((query) =>
      query === "first"
        ? { total: 1, tracks: [makeTrack("BV1xx411c7mD", "First")] }
        : new Promise(() => undefined),
    );
    library.searchNow("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(library.tracks[0]?.title).toBe("First");

    library.searchNow("second");
    expect(library.tracks[0]?.title).toBe("First");
    expect(library.searching).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(library.showSkeleton).toBe(false);
    expect(library.tracks[0]?.title).toBe("First");
  });

  it("discards superseded responses", async () => {
    const slow = deferred<unknown>();
    const library = makeLibrary((query) =>
      query === "slow"
        ? slow.promise
        : { total: 1, tracks: [makeTrack("BV1xx411c7mE", "Fast Song")] },
    );
    library.searchNow("slow");
    library.searchNow("fast");
    await vi.advanceTimersByTimeAsync(0);
    expect(library.tracks[0]?.title).toBe("Fast Song");

    slow.resolve({ total: 1, tracks: [makeTrack("BV1xx411c7mF", "Slow Song")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(library.tracks[0]?.title).toBe("Fast Song");
    expect(library.resultQuery).toBe("fast");
  });

  it("debounces input and only searches the latest query", async () => {
    const queries: Array<string> = [];
    const library = makeLibrary((query) => {
      queries.push(query);
      return { total: 0, tracks: [] };
    });
    library.requestSearch("x");
    await vi.advanceTimersByTimeAsync(100);
    library.requestSearch("xy");
    await vi.advanceTimersByTimeAsync(349);
    expect(queries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(queries).toEqual(["xy"]);
    expect(library.resultQuery).toBe("xy");
  });

  it("resets to the idle state when the input is cleared", async () => {
    const library = makeLibrary(() => ({ total: 1, tracks: [makeTrack("BV1xx411c7mD", "A")] }));
    library.searchNow("song");
    await vi.advanceTimersByTimeAsync(0);
    expect(library.tracks).toHaveLength(1);
    library.requestSearch("   ");
    expect(library.tracks).toHaveLength(0);
    expect(library.resultQuery).toBe("");
    expect(library.searching).toBe(false);
  });

  it("maps server error codes to notices", async () => {
    const failing = new MusicLibrary(
      new MusicClient("/status", "/search", async () =>
        Response.json({ error: "TIMEOUT" }, { status: 504 }),
      ),
    );
    failing.searchNow("song");
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.searchError).toBe("音乐平台响应超时，请重试");
  });

  it("recovers when a retried search succeeds", async () => {
    let fail = true;
    const library = makeLibrary(() => {
      if (fail) return Promise.reject(new TypeError("network down"));
      return { total: 1, tracks: [makeTrack("BV1xx411c7mD", "Recovered")] };
    });
    library.searchNow("song");
    await vi.advanceTimersByTimeAsync(0);
    expect(library.searchError).toBe("网络异常，请稍后重试");

    fail = false;
    library.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(library.searchError).toBeUndefined();
    expect(library.tracks[0]?.title).toBe("Recovered");
  });
});

describe("MusicLibrary status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeStatusLibrary(handler: () => Response | Promise<Response>): {
    library: MusicLibrary;
    calls: () => number;
  } {
    let statusCalls = 0;
    const client = new MusicClient("/status", "/search", async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/status")) {
        statusCalls += 1;
        return handler();
      }
      return Response.json({ total: 0, tracks: [] });
    });
    return { library: new MusicLibrary(client), calls: () => statusCalls };
  }

  it("warms once and reuses the status within the TTL", async () => {
    const { library, calls } = makeStatusLibrary(() => Response.json(STATUS));
    library.warm();
    await vi.advanceTimersByTimeAsync(0);
    expect(library.status?.available).toBe(true);
    expect(calls()).toBe(1);
    library.warm();
    library.ensureStatus();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);
  });

  it("marks failures and recovers on retry", async () => {
    let fail = true;
    const { library } = makeStatusLibrary(() =>
      fail
        ? Response.json({ error: "BACKEND_UNAVAILABLE" }, { status: 503 })
        : Response.json(STATUS),
    );
    library.ensureStatus();
    await vi.advanceTimersByTimeAsync(0);
    expect(library.statusFailed).toBe(true);
    fail = false;
    library.retryStatus();
    await vi.advanceTimersByTimeAsync(0);
    expect(library.statusFailed).toBe(false);
    expect(library.status?.available).toBe(true);
  });
});
