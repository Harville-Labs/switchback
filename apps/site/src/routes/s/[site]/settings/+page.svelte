<script lang="ts">
import { enhance } from '$app/forms';
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();

const options = [
  ['on', 'On for every member'],
  ['user', "Each member's own choice"],
  ['off', 'Off for every member'],
] as const;
</script>

<svelte:head><title>Settings · {data.site.name}</title></svelte:head>

<Flash error={form?.error} notice={form?.notice} />
<h2 class="mb-2 text-lg font-semibold">Usage statistics</h2>
<form method="POST" action="?/telemetry" use:enhance class="card flex flex-col gap-3">
  <p>
    Members' Harness can send anonymous daily statistics (counts, token totals, costs, and routing
    decisions; never prompts, code, or file names) to this site, where Harville Labs uses them to
    support you and improve Harness. A member's <code>DO_NOT_TRACK</code> setting always wins.
  </p>
  <fieldset class="flex flex-col gap-1">
    <legend class="sr-only">Usage statistics</legend>
    {#each options as [value, label] (value)}
      <label class="flex items-center gap-2">
        <input type="radio" name="telemetry" {value} checked={data.telemetry === value} />
        {label}
      </label>
    {/each}
  </fieldset>
  <button class="btn self-start">Save</button>
</form>

<h2 class="mt-8 mb-2 text-lg font-semibold">Seats</h2>
<p class="card">{data.site.seats} seats. Contact Harville Labs to change your plan.</p>
