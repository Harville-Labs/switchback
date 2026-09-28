<script lang="ts">
import { enhance } from '$app/forms';
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();

const usd = (n: number) => `$${n.toFixed(2)}`;
const t = $derived(data.telemetry);
const calls = $derived(t.calls.local + t.calls.remote);
</script>

<svelte:head><title>Operator · Harness</title></svelte:head>

<h1 class="mb-4 text-2xl font-semibold">Harville Labs operator</h1>
<Flash error={form?.error} notice={form?.notice} />

<h2 class="mt-6 mb-2 text-lg font-semibold">Telemetry, last 30 days</h2>
<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
  <div class="card"><div class="label">Installs</div><div class="text-2xl">{t.installs}</div></div>
  <div class="card">
    <div class="label">Local share of calls</div>
    <div class="text-2xl">{calls ? `${Math.round((t.calls.local / calls) * 100)}%` : '—'}</div>
  </div>
  <div class="card"><div class="label">Remote spend</div><div class="text-2xl">{usd(t.costUsd)}</div></div>
  <div class="card"><div class="label">Saved vs. all-remote</div><div class="text-2xl">{usd(t.savingsUsd)}</div></div>
</div>

<div class="mt-3 grid gap-3 md:grid-cols-2">
  <div class="card overflow-x-auto p-0">
    <table class="table">
      <thead><tr><th>Site</th><th>Installs</th><th>Calls</th><th>Spend</th><th>Saved</th></tr></thead>
      <tbody>
        {#each t.bySite as s (s.site)}
          <tr><td>{s.site}</td><td>{s.installs}</td><td>{s.calls}</td><td>{usd(s.costUsd)}</td><td>{usd(s.savingsUsd)}</td></tr>
        {:else}
          <tr><td colspan="5" class="muted">No reports yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div class="card overflow-x-auto p-0">
    <table class="table">
      <thead><tr><th>Routing rule</th><th>Local</th><th>Remote</th><th>Spend</th></tr></thead>
      <tbody>
        {#each t.byRule as r (r.rule)}
          <tr><td><code>{r.rule}</code></td><td>{r.local}</td><td>{r.remote}</td><td>{usd(r.costUsd)}</td></tr>
        {:else}
          <tr><td colspan="4" class="muted">No reports yet.</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

{#if t.versions.length}
  <p class="muted mt-3 text-sm">
    Versions: {t.versions.map((v) => `${v.version} (${v.installs})`).join(', ')}
  </p>
{/if}

{#if t.crashes.length}
  <h2 class="mt-6 mb-2 text-lg font-semibold">Recent crashes</h2>
  {#each t.crashes as c, i (i)}
    <details class="card mb-2">
      <summary><b>{c.name}</b> <span class="muted">{c.day} · {c.site}</span> {c.message}</summary>
      <pre class="mt-2 overflow-x-auto text-xs">{c.stack}</pre>
    </details>
  {/each}
{/if}

<h2 class="mt-8 mb-2 text-lg font-semibold">Sites</h2>
<form method="POST" action="?/create" use:enhance class="card mb-3 grid gap-2 md:grid-cols-[1fr_1fr_90px_1fr_auto] md:items-end">
  <label class="flex flex-col gap-1"><span class="label">Company</span><input class="field" name="name" required /></label>
  <label class="flex flex-col gap-1">
    <span class="label">Site ID</span>
    <input class="field" name="slug" required pattern="[a-z][a-z0-9-]{'{'}1,38{'}'}[a-z0-9]" placeholder="acme" />
  </label>
  <label class="flex flex-col gap-1"><span class="label">Seats</span><input class="field" name="seats" type="number" min="1" value="10" required /></label>
  <label class="flex flex-col gap-1"><span class="label">Owner email</span><input class="field" name="owner" type="email" required /></label>
  <button class="btn">Create site</button>
</form>
<div class="card overflow-x-auto p-0">
  <table class="table">
    <thead><tr><th>Site</th><th>ID</th><th>Seats</th><th></th></tr></thead>
    <tbody>
      {#each data.sites as s (s.id)}
        <tr>
          <td><a href="/s/{s.slug}">{s.name}</a></td>
          <td><code>{s.slug}</code></td>
          <td>{s.used} / {s.seats}</td>
          <td>
            <form method="POST" action="?/seats" use:enhance class="flex justify-end gap-2">
              <input type="hidden" name="site" value={s.slug} />
              <input class="field w-24 py-1" name="seats" type="number" min="1" value={s.seats} aria-label="Seats for {s.name}" />
              <button class="btn quiet py-1">Set seats</button>
            </form>
          </td>
        </tr>
      {:else}
        <tr><td colspan="4" class="muted">No sites yet.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
