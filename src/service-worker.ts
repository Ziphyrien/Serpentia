/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { base, build, files, prerendered, version } from "$service-worker";

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE_PREFIX = "serpentia-";
const CACHE_NAME = `${CACHE_PREFIX}${version}`;
const APP_SHELL = `${base}/`;
const PRECACHE_URLS = [...new Set([...build, ...files, ...prerendered, APP_SHELL])];
const PRECACHE_PATHS = new Set(PRECACHE_URLS);

worker.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await worker.clients.claim();
    })(),
  );
});

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== worker.location.origin ||
    url.pathname.startsWith(`${base}/api/`) ||
    request.headers.has("range")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (PRECACHE_PATHS.has(url.pathname)) event.respondWith(cacheFirstAsset(request, url.pathname));
});

async function networkFirstNavigation(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(APP_SHELL, response.clone());
    return response;
  } catch {
    return (await cache.match(APP_SHELL)) ?? Response.error();
  }
}

async function cacheFirstAsset(request: Request, cacheKey: string): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(cacheKey, response.clone());
  return response;
}
