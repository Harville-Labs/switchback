<script lang="ts">
import { page } from '$app/state';
import CopyCommand from '$lib/components/CopyCommand.svelte';

let { data, children } = $props();

const tabs = $derived([
  { path: '', label: 'Overview', show: true },
  { path: '/members', label: 'Members', show: true },
  { path: '/policy', label: 'Policy', show: data.manager },
  { path: '/devices', label: 'Devices', show: true },
  { path: '/settings', label: 'Settings', show: data.manager },
  { path: '/audit', label: 'Audit log', show: data.manager },
]);
const base = $derived(`/sites/${data.site.slug}`);
const isDevicePage = $derived(page.route.id?.endsWith('/device') ?? false);
</script>

{#if !isDevicePage}
  <h1 class="page-title">{data.site.name}</h1>
  <div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
    <span class="label">Connect Harness</span>
    <CopyCommand command="harness login --site {data.site.slug}" quiet />
  </div>
  {#if data.harnessManager && data.role !== 'operator'}
    <p class="card mb-4 text-sm">
      You're viewing this site as a Harness manager{data.role ? ` (you're also its ${data.role})` : ''}.
      <a href="/admin/{data.site.slug}">Assign operators and seats</a>.
    </p>
  {/if}
  <nav class="tabs" aria-label="Site">
    {#each tabs.filter((t) => t.show) as tab (tab.path)}
      {@const href = `${base}${tab.path}`}
      <a {href} aria-current={page.url.pathname.replace(/\/$/, '') === href ? 'page' : undefined}
        >{tab.label}</a
      >
    {/each}
  </nav>
{/if}
{@render children()}
