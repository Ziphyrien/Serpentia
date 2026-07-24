type LegacyFullscreenElement = HTMLElement & {
  readonly webkitRequestFullscreen?: () => Promise<void> | void;
};

type LegacyFullscreenDocument = Document & {
  readonly webkitFullscreenElement?: Element | null;
};

/** Requests browser fullscreen on every eligible touch while running in a normal tab. */
export function installTouchFullscreen(): () => void {
  const root: LegacyFullscreenElement = document.documentElement;
  const fullscreenDocument: LegacyFullscreenDocument = document;
  let requestPending = false;

  const requestFullscreen = (): void => {
    if (
      requestPending ||
      document.fullscreenElement != null ||
      fullscreenDocument.webkitFullscreenElement != null ||
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
      .catch(() => undefined)
      .finally(() => {
        requestPending = false;
      });
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch" || event.pointerType === "pen") requestFullscreen();
  };
  const onTouchEnd = (): void => requestFullscreen();

  window.addEventListener("pointerup", onPointerUp, { capture: true, passive: true });
  window.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  return () => {
    window.removeEventListener("pointerup", onPointerUp, { capture: true });
    window.removeEventListener("touchend", onTouchEnd, { capture: true });
  };
}
