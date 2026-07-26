type LegacyFullscreenElement = HTMLElement & {
  readonly webkitRequestFullscreen?: () => Promise<void> | void;
};

type LegacyFullscreenDocument = Document & {
  readonly webkitFullscreenElement?: Element | null;
};

const INLINE_SAFE_AREA_CONTAINED_ATTRIBUTE = "data-inline-safe-area-contained";

function isFullscreen(document: LegacyFullscreenDocument): boolean {
  return document.fullscreenElement != null || document.webkitFullscreenElement != null;
}

/**
 * Chrome on some Android devices keeps the cutout outside the layout viewport but still exposes
 * its inset. Mark that case so HUD controls do not apply the same horizontal inset a second time.
 */
function syncContainedInlineSafeArea(
  root: HTMLElement,
  fullscreenDocument: LegacyFullscreenDocument,
): void {
  const style = getComputedStyle(root);
  const readInset = (side: "left" | "right"): number => {
    const value = Number.parseFloat(style.getPropertyValue(`--safe-area-${side}`));
    return Number.isFinite(value) ? value : 0;
  };
  const inlineInset = readInset("left") + readInset("right");
  const excludedInlineSize = Math.max(0, screen.width - window.innerWidth);
  const insetIsAlreadyExcluded =
    isFullscreen(fullscreenDocument) &&
    inlineInset > 0 &&
    excludedInlineSize >= inlineInset - 1;

  root.toggleAttribute(INLINE_SAFE_AREA_CONTAINED_ATTRIBUTE, insetIsAlreadyExcluded);
}

/** Requests browser fullscreen on every eligible touch while running in a normal tab. */
export function installTouchFullscreen(): () => void {
  const root: LegacyFullscreenElement = document.documentElement;
  const fullscreenDocument: LegacyFullscreenDocument = document;
  let requestPending = false;

  const requestFullscreen = (): void => {
    if (
      requestPending ||
      isFullscreen(fullscreenDocument) ||
      window.matchMedia("(display-mode: fullscreen)").matches
    ) {
      return;
    }

    let requested: Promise<void> | void;
    try {
      if (typeof root.requestFullscreen === "function") {
        requested = root.requestFullscreen();
      } else if (typeof root.webkitRequestFullscreen === "function") {
        requested = root.webkitRequestFullscreen();
      } else {
        return;
      }
    } catch {
      return;
    }

    requestPending = true;
    if (requested === undefined) {
      window.setTimeout(() => {
        requestPending = false;
      }, 500);
      return;
    }
    void requested
      .then(() => screen.orientation.lock("landscape"))
      .catch(() => undefined)
      .finally(() => {
        requestPending = false;
      });
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch" || event.pointerType === "pen") requestFullscreen();
  };
  const onTouchEnd = (): void => requestFullscreen();
  const syncSafeArea = (): void => syncContainedInlineSafeArea(root, fullscreenDocument);
  let delayedSafeAreaSync: number | undefined;
  const scheduleSafeAreaSync = (): void => {
    syncSafeArea();
    window.clearTimeout(delayedSafeAreaSync);
    delayedSafeAreaSync = window.setTimeout(syncSafeArea, 500);
  };

  scheduleSafeAreaSync();
  window.addEventListener("resize", scheduleSafeAreaSync);
  window.addEventListener("orientationchange", scheduleSafeAreaSync);
  document.addEventListener("fullscreenchange", scheduleSafeAreaSync);
  document.addEventListener("webkitfullscreenchange", scheduleSafeAreaSync);
  window.addEventListener("pointerup", onPointerUp, { capture: true, passive: true });
  window.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  return () => {
    window.clearTimeout(delayedSafeAreaSync);
    window.removeEventListener("resize", scheduleSafeAreaSync);
    window.removeEventListener("orientationchange", scheduleSafeAreaSync);
    document.removeEventListener("fullscreenchange", scheduleSafeAreaSync);
    document.removeEventListener("webkitfullscreenchange", scheduleSafeAreaSync);
    window.removeEventListener("pointerup", onPointerUp, { capture: true });
    window.removeEventListener("touchend", onTouchEnd, { capture: true });
    root.removeAttribute(INLINE_SAFE_AREA_CONTAINED_ATTRIBUTE);
  };
}
