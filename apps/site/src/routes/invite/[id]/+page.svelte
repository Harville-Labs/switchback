<script lang="ts">
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();
</script>

<svelte:head><title>Invitation · Harness</title></svelte:head>

<section class="mx-auto mt-10 max-w-md">
  <h1 class="mb-4 text-2xl font-semibold">Join {data.invitation.site}</h1>
  <Flash error={form?.error} />
  {#if !data.usable}
    <p class="card">This invitation has expired or was already answered. Ask the site's operator for a new one.</p>
  {:else if data.mismatch}
    <p class="card">
      This invitation is for {data.invitation.email}, but you're signed in as {data.email}. Sign out,
      then sign in with that address.
    </p>
  {:else}
    <form method="POST" class="card flex flex-col gap-3">
      <p>
        You're invited to {data.invitation.site} on Harness as
        {data.invitation.role === 'member' ? 'a member' : `an ${data.invitation.role}`}.
      </p>
      <button class="btn self-start">Accept</button>
    </form>
  {/if}
</section>
