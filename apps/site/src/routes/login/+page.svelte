<script lang="ts">
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();
</script>

<svelte:head><title>Sign in · Harness</title></svelte:head>

<section class="mx-auto mt-10 max-w-md">
  <h1 class="mb-1 text-2xl font-semibold">Sign in</h1>
  <p class="muted mb-4">Your company's Harness site: members, policy, and usage.</p>
  <Flash error={form?.error} />
  {#if form?.sent}
    <div class="card">
      If <b>{form.sent}</b> belongs to a Harness site, a sign-in link is on its way. It works once
      and expires in 15 minutes.
    </div>
  {:else}
    <form method="POST" class="card flex flex-col gap-3">
      <label class="flex flex-col gap-1">
        <span class="label">Work email</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="field" type="email" name="email" autocomplete="email" required autofocus />
      </label>
      <input type="hidden" name="next" value={data.next} />
      <button class="btn self-start">Email me a sign-in link</button>
    </form>
  {/if}
</section>
