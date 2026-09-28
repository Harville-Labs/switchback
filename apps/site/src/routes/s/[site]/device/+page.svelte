<script lang="ts">
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();
</script>

<svelte:head><title>Sign in Harness · {data.site.name}</title></svelte:head>

<section class="mx-auto mt-6 max-w-lg">
  <h1 class="mb-4 text-2xl font-semibold">Sign in Harness to {data.site.name}</h1>
  <Flash error={form?.error ?? data.problem} />
  {#if form?.done === 'approved'}
    <p class="card">Done. Harness is signed in as {data.email}. You can close this tab.</p>
  {:else if form?.done === 'denied'}
    <p class="card">Denied. That Harness wasn't signed in.</p>
  {:else if data.code && !data.problem}
    <form method="POST" class="card flex flex-col gap-3">
      <p>Check that this code matches the one in your terminal or editor:</p>
      <p class="font-mono text-3xl font-semibold tracking-widest">{data.code}</p>
      <p class="muted">
        Harness will receive {data.site.name}'s policy and report usage as {data.email}.
      </p>
      <input type="hidden" name="code" value={data.code} />
      <div class="flex gap-2">
        <button class="btn" name="decision" value="approve">Sign in</button>
        <button class="btn quiet" name="decision" value="deny">This wasn't me</button>
      </div>
    </form>
  {:else if !data.problem || !data.code}
    <form method="GET" class="card flex gap-2">
      <!-- svelte-ignore a11y_autofocus -->
      <input class="field flex-1 font-mono uppercase" name="user_code" placeholder="XXXXXXXX" aria-label="Code" required autofocus />
      <button class="btn">Continue</button>
    </form>
  {/if}
</section>
