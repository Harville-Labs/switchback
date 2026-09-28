<script lang="ts">
let { data } = $props();
</script>

<svelte:head><title>Audit log · {data.site.name}</title></svelte:head>

<div class="card overflow-x-auto p-0">
  <table class="table">
    <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
    <tbody>
      {#each data.entries as e, i (i)}
        <tr>
          <td class="muted whitespace-nowrap">{new Date(e.at).toLocaleString()}</td>
          <td>{e.actor ?? 'system'}</td>
          <td><code>{e.action}</code></td>
          <td>{e.detail ?? ''}</td>
        </tr>
      {:else}
        <tr><td colspan="4" class="muted">Nothing yet.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
