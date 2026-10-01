<script lang="ts">
import CopyCommand from '$lib/components/CopyCommand.svelte';

let { data } = $props();
</script>

<svelte:head><title>Your sites · Harness</title></svelte:head>

<h1 class="mb-4 page-title">Your sites</h1>
{#if data.user?.harnessManager}
  <p class="muted mb-4">
    As a Harness manager you can see <a href="/admin">every site</a> and assign its operators.
  </p>
{/if}
{#each data.invitations as i (i.id)}
  <p class="card mb-3">
    You're invited to <b>{i.site}</b>. <a href="/invite/{i.id}">Accept the invitation</a>
  </p>
{/each}
{#if data.sites.length}
  <div class="card overflow-x-auto p-0">
    <table class="table">
      <thead><tr><th>Site</th><th>Role</th><th>Connect Harness</th></tr></thead>
      <tbody>
        {#each data.sites as s (s.slug)}
          <tr>
            <td><a href="/sites/{s.slug}" class="font-medium">{s.name}</a></td>
            <td>{s.role}</td>
            <td><CopyCommand command="harness login --site {s.slug}" quiet /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <p class="muted">
    You aren't a member of any site yet. Ask your company's Harness operator to invite {data.user?.email}.
  </p>
{/if}
