<script lang="ts">
import { enhance } from '$app/forms';
import Flash from '$lib/components/Flash.svelte';

let { data, form } = $props();

const options = [
  ['on', 'On for every member'],
  ['user', "Each member's own choice"],
  ['off', 'Off for every member'],
] as const;
</script>

<svelte:head><title>Settings · {data.site.name}</title></svelte:head>

<Flash error={form?.error} notice={form?.notice} />
<h2 class="mb-2 text-lg font-semibold">Usage statistics</h2>
<form method="POST" action="?/telemetry" use:enhance class="card flex flex-col gap-3">
  <p>
    Members' Harness can send anonymous daily statistics (counts, token totals, costs, and routing
    decisions; never prompts, code, or file names) to this site, where Harville Labs uses them to
    support you and improve Harness. A member's <code>DO_NOT_TRACK</code> setting always wins.
  </p>
  <fieldset class="flex flex-col gap-1">
    <legend class="sr-only">Usage statistics</legend>
    {#each options as [value, label] (value)}
      <label class="flex items-center gap-2">
        <input type="radio" name="telemetry" {value} checked={data.telemetry === value} />
        {label}
      </label>
    {/each}
  </fieldset>
  <button class="btn self-start">Save</button>
</form>

<h2 class="mt-8 mb-2 text-lg font-semibold">Single sign-on</h2>
<div class="card flex flex-col gap-3">
  <p>
    Let members sign in through your company's identity provider (OIDC: Okta, Microsoft Entra ID,
    Google Workspace, and others). It signs people in to {data.site.name} only, and only addresses
    at your verified domain that are members here or have an invitation.
  </p>
  {#if data.sso}
    <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      <dt class="label">Issuer</dt><dd><code>{data.sso.issuer}</code></dd>
      <dt class="label">Domain</dt>
      <dd>@{data.sso.domain} {data.sso.verified ? '· verified' : '· not verified yet'}</dd>
      <dt class="label">Redirect URI</dt><dd><code class="break-all">{data.callbackUrl}</code></dd>
    </dl>
    {#if !data.sso.verified && data.sso.record}
      <p class="text-sm">
        Prove you own the domain with this DNS TXT record, then verify. Until then, nobody can sign
        in with it.
      </p>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt class="label">Name</dt><dd><code class="break-all">{data.sso.record.name}</code></dd>
        <dt class="label">Value</dt><dd><code class="break-all">{data.sso.record.value}</code></dd>
      </dl>
    {/if}
    {#if data.canSetUpSso}
      <div class="flex flex-wrap gap-2">
        {#if !data.sso.verified}
          <form method="POST" action="?/verify" use:enhance><button class="btn">Verify domain</button></form>
        {/if}
        <form method="POST" action="?/removeSso" use:enhance><button class="btn danger">Remove</button></form>
      </div>
      {#if data.sso.verified}
        <form method="POST" action="?/requireSso" use:enhance class="flex items-center gap-2">
          <label class="flex items-center gap-2">
            <input type="checkbox" name="required" checked={data.ssoRequired} />
            Require members to sign in with single sign-on
          </label>
          <button class="btn quiet py-1">Save</button>
        </form>
      {/if}
    {/if}
  {/if}
  {#if data.canSetUpSso}
    <details open={!data.sso}>
      <summary class="cursor-pointer">{data.sso ? 'Replace the identity provider' : 'Set up single sign-on'}</summary>
      <p class="muted mt-2 text-sm">
        Create an OIDC web application in your identity provider with the redirect URI
        <code class="break-all">{data.callbackUrl}</code>, then enter its details.
      </p>
      <form method="POST" action="?/sso" use:enhance class="mt-2 grid gap-2 md:grid-cols-2">
        <label class="flex flex-col gap-1"><span class="label">Issuer URL</span><input class="field" name="issuer" type="url" placeholder="https://acme.okta.com" required /></label>
        <label class="flex flex-col gap-1"><span class="label">Email domain</span><input class="field" name="domain" placeholder="acme.com" required /></label>
        <label class="flex flex-col gap-1"><span class="label">Client ID</span><input class="field" name="clientId" required /></label>
        <label class="flex flex-col gap-1"><span class="label">Client secret</span><input class="field" name="clientSecret" type="password" autocomplete="off" required /></label>
        <button class="btn self-start">Save</button>
      </form>
    </details>
  {:else}
    <p class="muted text-sm">The site's operators and admins set this up.</p>
  {/if}
</div>

<h2 class="mt-8 mb-2 text-lg font-semibold">Seats</h2>
<p class="card">{data.site.seats} seats. Contact Harville Labs to change your plan.</p>
