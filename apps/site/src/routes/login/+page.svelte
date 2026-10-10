<script lang="ts">
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();
</script>

<svelte:head><title>Sign in · Switchback</title></svelte:head>

<section class="mx-auto mt-10 max-w-md">
  <h1 class="mb-1 page-title">Sign in</h1>
  <p class="muted mb-4">
    Your company's Switchback site: members, policy, and usage. Using Switchback on your own? You don't
    need a site; <a href="https://switchback.sh">install Switchback</a> and go.
  </p>
  <Flash error={form?.error ?? data.error} />
  {#if form?.sent}
    <div class="card">
      If <b>{form.sent}</b> belongs to a Switchback site, a sign-in link is on its way. It works once
      and expires in 15 minutes.
    </div>
  {:else}
    <form method="POST" action="?/signIn" class="card flex flex-col gap-3">
      <label class="flex flex-col gap-1">
        <span class="label">Work email</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="field" type="email" name="email" autocomplete="email" required autofocus />
      </label>
      <input type="hidden" name="next" value={data.next} />
      <p class="muted text-sm">
        If your company uses single sign-on with Switchback, you'll go to its sign-in page.
      </p>
      <div class="flex flex-wrap gap-2">
        <button class="btn">Continue</button>
        <button class="btn quiet" name="link" value="1">Email me a link instead</button>
      </div>
    </form>
    {#if data.staffSso}
      <form method="POST" action="?/staff" class="mt-3 text-center">
        <input type="hidden" name="next" value={data.next === '/sites' ? '/admin' : data.next} />
        <button class="btn quiet">Harville Labs staff</button>
      </form>
    {/if}
  {/if}
</section>
