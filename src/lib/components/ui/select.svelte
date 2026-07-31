<script lang="ts" module>
  export interface SelectOption {
    value: string;
    label: string;
  }
</script>

<script lang="ts">
  import { Select } from "bits-ui";
  import Check from "lucide-svelte/icons/check";
  import ChevronDown from "lucide-svelte/icons/chevron-down";

  let {
    value = $bindable(""),
    options,
    ariaLabel,
  }: {
    value: string;
    options: ReadonlyArray<SelectOption>;
    ariaLabel?: string;
  } = $props();

  const TRIGGER_CLASS =
    "flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-bold text-white outline-none transition focus:border-lime-400/60 data-[state=open]:border-lime-400/60";
</script>

<Select.Root type="single" bind:value items={[...options]}>
  <Select.Trigger class={TRIGGER_CLASS} aria-label={ariaLabel}>
    <Select.Value class="truncate" />
    <ChevronDown size={14} class="shrink-0 text-white/50" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      class="z-[60] max-h-60 w-(--bits-select-anchor-width) overflow-y-auto rounded-xl border border-panel-border bg-night-900 p-1 text-white shadow-2xl"
      sideOffset={6}
    >
      <Select.Viewport>
        {#each options as option (option.value)}
          <Select.Item
            value={option.value}
            label={option.label}
            class="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-bold text-white/85 outline-none select-none data-[highlighted]:bg-white/10 data-[selected]:text-lime-300"
          >
            {#snippet children({ selected })}
              <span class="truncate">{option.label}</span>
              {#if selected}
                <Check size={14} class="shrink-0" />
              {/if}
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
    </Select.Content>
  </Select.Portal>
</Select.Root>
