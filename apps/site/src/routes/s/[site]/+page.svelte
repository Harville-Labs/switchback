<script lang="ts">
let { data } = $props();

const usd = (n: number) => `$${n.toFixed(2)}`;
const calls = $derived(data.usage.totals.local + data.usage.totals.remote);
</script>

<svelte:head><title>{data.site.name} · Harness</title></svelte:head>

<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
  <div class="card"><div class="label">Remote spend, 30 days</div><div class="text-2xl">{usd(data.usage.totals.costUsd)}</div></div>
  <div class="card">
    <div class="label">Calls on local models</div>
    <div class="text-2xl">{calls ? `${Math.round((data.usage.totals.local / calls) * 100)}%` : '—'}</div>
  </div>
  <div class="card"><div class="label">Model calls</div><div class="text-2xl">{calls.toLocaleString('en-US')}</div></div>
  {#if !data.own}
    <div class="card"><div class="label">Seats</div><div class="text-2xl">{data.seats.used} / {data.seats.total}</div></div>
  {/if}
</div>

<h2 class="mt-8 mb-2 text-lg font-semibold">{data.own ? 'Your usage by model' : 'By model'}</h2>
<div class="card overflow-x-auto p-0">
  <table class="table">
    <thead><tr><th>Model</th><th>Tier</th><th>Calls</th><th>Cost</th></tr></thead>
    <tbody>
      {#each data.usage.byModel as m (`${m.tier}/${m.model}`)}
        <tr><td>{m.model}</td><td>{m.tier}</td><td>{m.calls}</td><td>{usd(m.costUsd)}</td></tr>
      {:else}
        <tr><td colspan="4" class="muted">No usage reported yet. It appears once members sign in with Harness.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

{#if !data.own}
  <h2 class="mt-8 mb-2 text-lg font-semibold">By member</h2>
  <div class="card overflow-x-auto p-0">
    <table class="table">
      <thead><tr><th>Member</th><th>Calls</th><th>Local</th><th>Cost</th></tr></thead>
      <tbody>
        {#each data.usage.byMember as m (m.email)}
          <tr>
            <td>{m.email}</td>
            <td>{m.calls}</td>
            <td>{m.calls ? `${Math.round((m.localCalls / m.calls) * 100)}%` : '—'}</td>
            <td>{usd(m.costUsd)}</td>
          </tr>
        {:else}
          <tr><td colspan="4" class="muted">Nothing yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
