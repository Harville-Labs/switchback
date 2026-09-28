<script lang="ts">
import { enhance } from '$app/forms';
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();

const full = $derived(data.used >= data.site.seats);
// Only a Harness manager assigns or removes operators.
const roles = $derived(
  (['member', 'admin', 'operator'] as const).filter((r) => data.harnessManager || r !== 'operator'),
);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
</script>

<svelte:head><title>Members · {data.site.name}</title></svelte:head>

<Flash error={form?.error} notice={form?.notice} />
<p class="muted mb-3">
  {data.used} of {data.site.seats} seats used. Invited people take a seat until they're removed.
</p>

{#if data.manager}
  <form method="POST" action="?/invite" use:enhance class="card mb-4 flex flex-wrap items-end gap-2">
    <label class="flex min-w-60 flex-1 flex-col gap-1">
      <span class="label">Email</span>
      <input class="field" type="email" name="email" placeholder="colleague@company.com" required />
    </label>
    <label class="flex flex-col gap-1">
      <span class="label">Role</span>
      <select class="field" name="role">
        {#each roles as r (r)}<option value={r}>{r}</option>{/each}
      </select>
    </label>
    <button class="btn" disabled={full}>Invite</button>
    {#if full}<span class="muted">All seats are taken.</span>{/if}
  </form>
{/if}

<div class="card overflow-x-auto p-0">
  <table class="table">
    <thead>
      <tr><th>Member</th><th>Role</th><th>Status</th><th>Devices</th><th>Last seen</th>{#if data.manager}<th></th>{/if}</tr>
    </thead>
    <tbody>
      {#each data.members as m (m.id)}
        {@const editable = data.manager && (data.harnessManager || m.role !== 'operator')}
        <tr>
          <td>{m.email}</td>
          <td>
            {#if editable}
              <form method="POST" action="?/role" use:enhance class="flex gap-2">
                <input type="hidden" name="user" value={m.id} />
                <select class="field py-1" name="role" aria-label="Role for {m.email}">
                  {#each roles as r (r)}<option value={r} selected={r === m.role}>{r}</option>{/each}
                </select>
                <button class="btn quiet py-1">Save</button>
              </form>
            {:else}{m.role}{/if}
          </td>
          <td class={m.status === 'invited' ? 'muted' : ''}>{m.status}</td>
          <td>{m.devices}</td>
          <td class="muted">{when(m.lastSeen)}</td>
          {#if data.manager}
            <td class="text-right">
              {#if editable}
                <form method="POST" action="?/remove" use:enhance>
                  <input type="hidden" name="user" value={m.id} />
                  <button class="btn danger py-1">Remove</button>
                </form>
              {/if}
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
