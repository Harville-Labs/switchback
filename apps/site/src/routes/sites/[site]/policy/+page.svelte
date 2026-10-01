<script lang="ts">
import { enhance } from '$app/forms';
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();

let text = $state('');
// Start from the saved policy; after a failed save, keep what was typed.
$effect.pre(() => {
  text = form && 'text' in form && form.text !== undefined ? form.text : data.text;
});
const problems = $derived(form && 'problems' in form ? form.problems : undefined);
</script>

<svelte:head><title>Policy · {data.site.name}</title></svelte:head>

<Flash notice={form && 'notice' in form ? form.notice : undefined} error={form && 'error' in form ? form.error : undefined} />
<p class="muted mb-3">
  What members' Harness receives: <code>defaults</code> (below their own config), <code>enforced</code>
  (above it), and <code>restrictions</code>. Saving creates version {data.version + 1}.
</p>
{#if problems?.length}
  <div class="flash error mb-3" role="alert">
    Not saved. Fix these first:
    <ul class="ml-5 list-disc">{#each problems as p (p)}<li>{p}</li>{/each}</ul>
  </div>
{/if}
<form method="POST" action="?/save" use:enhance={() => ({ update }) => update({ reset: false })}>
  <textarea
    class="field min-h-[420px] w-full font-mono text-[13px] leading-snug"
    name="policy"
    spellcheck="false"
    aria-label="Policy JSON"
    bind:value={text}
  ></textarea>
  <div class="mt-2 flex gap-2">
    <input class="field flex-1" name="note" placeholder="What changed (optional)" />
    <button class="btn">Save version {data.version + 1}</button>
  </div>
</form>

<h2 class="mt-8 mb-2 section-title">History</h2>
<div class="card overflow-x-auto p-0">
  <table class="table">
    <thead><tr><th>Version</th><th>When</th><th>By</th><th>Note</th><th></th></tr></thead>
    <tbody>
      {#each data.history as h (h.version)}
        <tr>
          <td>{h.version}</td>
          <td class="muted">{new Date(h.createdAt).toLocaleString()}</td>
          <td>{h.by ?? '—'}</td>
          <td>{h.note ?? ''}</td>
          <td class="text-right">
            {#if h.version === data.version}
              <span class="muted">current</span>
            {:else}
              <form method="POST" action="?/restore" use:enhance>
                <input type="hidden" name="version" value={h.version} />
                <button class="btn quiet py-1">Restore</button>
              </form>
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="5" class="muted">No policy yet: members get Harness's defaults.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
