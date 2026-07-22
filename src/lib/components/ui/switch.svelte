<script lang="ts">
  import { Switch } from "bits-ui";

  let {
    checked = $bindable(false),
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } = $props();
</script>

<Switch.Root
  bind:checked
  {onCheckedChange}
  class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full bg-white/20 transition-colors data-[state=checked]:bg-lime-400"
>
  <Switch.Thumb
    class="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-5.5"
  />
</Switch.Root>
