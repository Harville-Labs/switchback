<script lang="ts">
import '../app.css';
import { page } from '$app/state';
import Monogram from '$lib/components/Monogram.svelte';

let { data, children } = $props();
let menuOpen = $state(false);
const close = () => (menuOpen = false);
</script>

<a class="skip-link" href="#top">Skip to content</a>

<header class="topbar">
  <div class="frame topbar-inner">
    <a class="brand" href="/" aria-label="Switchback sites" onclick={close}>
      <Monogram />
      <span>Switchback</span>
      <small class="hidden sm:inline">Sites</small>
    </a>
    <nav class:open={menuOpen} aria-label="Primary">
      {#if data.user}
        {#if data.user.switchbackManager}
          <a href="/admin" class="nav-item" class:active={page.url.pathname.startsWith('/admin')} onclick={close}>All sites</a>
        {/if}
        <a href="/sites" class="nav-item" class:active={page.url.pathname === '/sites'} onclick={close}>Your sites</a>
        <span class="who">{data.user.email}</span>
        <form method="POST" action="/logout"><button class="nav-item pill">Sign out</button></form>
      {:else}
        <a href="https://switchback.sh" class="nav-item">About Switchback</a>
        <a href="/login" class="nav-item pill" class:active={page.url.pathname === '/login'} onclick={close}>Sign in</a>
      {/if}
    </nav>
    <button class="menu-toggle" type="button" aria-expanded={menuOpen} aria-label={menuOpen ? 'Close menu' : 'Open menu'} onclick={() => (menuOpen = !menuOpen)}>{menuOpen ? 'Close' : 'Menu'}</button>
  </div>
</header>

<main id="top" class="frame console">{@render children()}</main>

<footer class="site-footer">
  <div class="frame footer-row">
    <a class="brand" href="https://harville.ai" aria-label="Harville Labs"><Monogram /><span>Harville Labs</span></a>
    <nav class="footer-links" aria-label="Footer">
      <a href="https://switchback.sh">Switchback</a>
      <a href="https://github.com/Harville-Labs/switchback">GitHub ↗</a>
      <a href="mailto:hello@harville.ai">hello@harville.ai</a>
    </nav>
    <p class="label">© {new Date().getFullYear()} Harville Labs, LLC</p>
  </div>
</footer>
