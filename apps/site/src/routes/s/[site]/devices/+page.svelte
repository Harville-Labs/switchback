<script lang="ts">
import { enhance } from '$app/forms';
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();
</script>

<svelte:head><title>Devices · {data.site.name}</title></svelte:head>

<Flash error={form?.error} notice={form?.notice} />
<p class="muted mb-3">
  {data.manager ? 'Every Harness signed in to this site.' : 'Where you have Harness signed in to this site.'}
</p>
<div class="card overflow-x-auto p-0">
  <table class="table">
    <thead><tr><th>Member</th><th>Client</th><th>Signed in</th><th>Last seen</th><th></th></tr></thead>
    <tbody>
      {#each data.devices as d (d.id)}
        <tr>
          <td>{d.email}</td>
          <td class="max-w-64 truncate" title={d.client ?? ''}>{d.client ?? 'harness'}</td>
          <td class="muted">{new Date(d.createdAt).toLocaleDateString()}</td>
          <td class="muted">{d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '—'}</td>
          <td class="text-right">
            <form method="POST" action="?/revoke" use:enhance>
              <input type="hidden" name="device" value={d.id} />
              <button class="btn danger py-1">Sign out</button>
            </form>
          </td>
        </tr>
      {:else}
        <tr><td colspan="5" class="muted">No devices are signed in.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
