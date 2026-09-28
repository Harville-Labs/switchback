<script lang="ts">
import { enhance } from '$app/forms';
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();

const full = $derived(data.used >= data.site.seats);
</script>

<svelte:head><title>{data.site.name} · Harness managers</title></svelte:head>

<p class="muted mb-1 text-sm"><a href="/admin">Harness managers</a> / {data.site.slug}</p>
<h1 class="text-2xl font-semibold">{data.site.name}</h1>
<p class="muted mb-4">
  {data.used} of {data.site.seats} seats used · usage statistics {data.site.telemetry} ·
  <a href="/s/{data.site.slug}">Open the site console</a>
</p>
<Flash error={form?.error} notice={form?.notice} />

<h2 class="mt-6 mb-2 text-lg font-semibold">Operators</h2>
<p class="muted mb-2 text-sm">
  Operators run the site for their company: they manage its members, admins, policy, and devices.
  Only Harness managers assign them, and a site always keeps at least one.
</p>
<form method="POST" action="?/assign" use:enhance class="card mb-3 flex flex-wrap items-end gap-2">
  <label class="flex min-w-60 flex-1 flex-col gap-1">
    <span class="label">Email</span>
    <input class="field" type="email" name="email" placeholder="lead@company.com" required />
  </label>
  <button class="btn">Assign operator</button>
  <span class="muted text-sm">
    {full
      ? 'All seats are taken, so only an existing member can be made an operator.'
      : 'A current member is promoted; anyone else is invited and takes a seat.'}
  </span>
</form>
<div class="card overflow-x-auto p-0">
  <table class="table">
    <thead><tr><th>Operator</th><th>Status</th><th></th></tr></thead>
    <tbody>
      {#each data.operators as o (o.id)}
        <tr>
          <td>{o.email}</td>
          <td class={o.status === 'invited' ? 'muted' : ''}>{o.status}</td>
          <td>
            <div class="flex justify-end gap-2">
              <form method="POST" action="?/demote" use:enhance>
                <input type="hidden" name="user" value={o.id} />
                <button class="btn quiet py-1">Make admin</button>
              </form>
              <form method="POST" action="?/remove" use:enhance>
                <input type="hidden" name="user" value={o.id} />
                <button class="btn danger py-1">Remove from site</button>
              </form>
            </div>
          </td>
        </tr>
      {:else}
        <tr><td colspan="3" class="muted">No operators. Assign one above.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
<p class="muted mt-2 text-sm">
  {data.others} other {data.others === 1 ? 'member' : 'members'}; see
  <a href="/s/{data.site.slug}/members">Members</a>.
</p>

<h2 class="mt-8 mb-2 text-lg font-semibold">Seats</h2>
<form method="POST" action="?/seats" use:enhance class="card flex flex-wrap items-end gap-2">
  <label class="flex flex-col gap-1">
    <span class="label">Seats</span>
    <input class="field w-28" name="seats" type="number" min="1" value={data.site.seats} />
  </label>
  <button class="btn">Set seats</button>
</form>
