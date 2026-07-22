<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  const BASE =
    "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full font-black transition select-none active:scale-95 disabled:pointer-events-none disabled:opacity-50";

  const INTENTS = {
    primary:
      "bg-gradient-to-b from-lime-300 to-lime-500 text-night-950 shadow-[0_4px_0_#3f7a1d] active:shadow-[0_1px_0_#3f7a1d]",
    ghost: "border border-panel-border bg-panel text-white/85 backdrop-blur-sm hover:bg-white/10",
    danger: "bg-red-500/85 text-white shadow-[0_4px_0_#7f1d1d] active:shadow-[0_1px_0_#7f1d1d]",
  } as const;

  const SIZES = {
    md: "px-5 py-2 text-sm",
    sm: "px-3.5 py-1.5 text-xs",
    icon: "size-11",
  } as const;

  type Props = HTMLButtonAttributes & {
    intent?: keyof typeof INTENTS;
    size?: keyof typeof SIZES;
    children: Snippet;
  };

  let { intent = "ghost", size = "md", class: className, children, ...rest }: Props = $props();
</script>

<button class={[BASE, INTENTS[intent], SIZES[size], className]} {...rest}>
  {@render children()}
</button>
