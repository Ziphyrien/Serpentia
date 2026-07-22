<script lang="ts">
  import { Slider } from "bits-ui";

  let {
    value = $bindable(1),
    min = 0,
    max = 1,
    step = 0.05,
    onValueChange,
  }: {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    onValueChange?: (value: number) => void;
  } = $props();
</script>

<Slider.Root
  type="single"
  bind:value
  {min}
  {max}
  {step}
  {onValueChange}
  class="relative flex h-4 w-full cursor-pointer items-center"
>
  <div class="relative h-1.5 w-full overflow-hidden rounded-full bg-white/20">
    <Slider.Range class="absolute h-full rounded-full bg-lime-400" />
  </div>
  <Slider.Thumb
    index={0}
    class="absolute block size-4 cursor-grab rounded-full border-2 border-lime-400 bg-white shadow transition active:cursor-grabbing"
  />
</Slider.Root>
