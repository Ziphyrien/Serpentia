<script lang="ts">
  import { ASSET_PATHS } from "$lib/client/config";
  import { MAGNET } from "$lib/game/magnet";

  let { remaining }: { remaining: number } = $props();

  const progress = $derived(
    Math.min(1, Math.max(0, 1 - remaining / MAGNET.durationSeconds)),
  );
  const progressSector = $derived(radialSectorPath(progress));

  function radialSectorPath(value: number): string {
    if (value <= 0) return "";
    if (value >= 1) return "M0 0H60V60H0Z";
    const radius = 50;
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + value * Math.PI * 2;
    const endX = 30 + Math.cos(endAngle) * radius;
    const endY = 30 + Math.sin(endAngle) * radius;
    return `M30 30 L30 -20 A50 50 0 ${value > 0.5 ? 1 : 0} 1 ${endX} ${endY} Z`;
  }
</script>

{#if remaining > 0}
  <div
    class="magnet-status pointer-events-none absolute left-1/2 -translate-x-1/2"
    role="status"
    aria-label="磁铁效果"
  >
    <img class="status-background" src={ASSET_PATHS.tools.statusBackground} alt="" />
    <img class="status-icon" src={ASSET_PATHS.tools.magnet} alt="" />
    <svg class="status-progress" viewBox="0 0 60 60" aria-hidden="true">
      <defs>
        <clipPath id="magnet-progress-sector">
          <path d={progressSector} />
        </clipPath>
      </defs>
      <image
        href={ASSET_PATHS.tools.statusMask}
        width="60"
        height="60"
        clip-path="url(#magnet-progress-sector)"
      />
    </svg>
  </div>
{/if}

<style>
  .magnet-status {
    bottom: max(2.8dvh, var(--hud-safe-bottom));
    width: 8dvh;
    height: 8dvh;
  }

  .status-background,
  .status-progress {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .status-icon {
    position: absolute;
    top: 8.333%;
    left: 8.333%;
    width: 83.333%;
    height: 83.333%;
  }
</style>
