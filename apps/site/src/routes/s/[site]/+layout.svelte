<script lang="ts">
import { page } from '$app/state';

let { data, children } = $props();

const tabs = $derived([
  { path: '', label: 'Overview', show: true },
  { path: '/members', label: 'Members', show: true },
  { path: '/policy', label: 'Policy', show: data.manager },
  { path: '/devices', label: 'Devices', show: true },
  { path: '/settings', label: 'Settings', show: data.manager },
  { path: '/audit', label: 'Audit log', show: data.manager },
]);
const base = $derived(`/s/${data.site.slug}`);
const isDevicePage = $derived(page.route.id?.endsWith('/device') ?? false);
</script>

{#if !isDevicePage}
  <h1 class="text-2xl font-semibold">{data.site.name}</h1>
  <p class="muted mb-4">Connect Harness with <code>harness login --site {data.site.slug}</code></p>
  {#if data.harnessManager && data.role !== 'operator'}
    <p class="card mb-4 text-sm">
      You're viewing this site as a Harness manager{data.role ? ` (you're also its ${data.role})` : ''}.
      <a href="/admin/{data.site.slug}">Assign operators and seats</a>.
    </p>
  {/if}
  <nav class="mb-6 flex flex-wrap gap-1 border-b border-[var(--line)]" aria-label="Site">
    {#each tabs.filter((t) => t.show) as tab (tab.path)}
      {@const href = `${base}${tab.path}`}
      {@const current = page.url.pathname.replace(/\/$/, '') === href}
      <a
        {href}
        aria-current={current ? 'page' : undefined}
        class="-mb-px border-b-2 px-3 py-2 text-sm no-underline {current
          ? 'border-[var(--fg)]'
          : 'muted border-transparent hover:text-[var(--fg)]'}">{tab.label}</a
      >
    {/each}
  </nav>
{/if}
{@render children()}
