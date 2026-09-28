<script lang="ts">
import '../app.css';

let { data, children } = $props();
</script>

<header class="flex items-center gap-3 bg-ink px-5 py-3 text-paper">
  <a href="/" class="flex items-center gap-2 no-underline">
    <img src="/icon.svg" alt="" class="h-7 w-7 invert" />
    <span class="font-semibold">Harness</span>
  </a>
  <span class="text-sm opacity-60">by Harville Labs</span>
  {#if data.user}
    <nav class="ml-auto flex items-center gap-4 text-sm">
      {#if data.user.operator}<a href="/admin" class="opacity-80 hover:opacity-100">Operator</a>{/if}
      <span class="hidden opacity-60 sm:inline">{data.user.email}</span>
      <form method="POST" action="/logout">
        <button class="rounded border border-white/20 px-3 py-1 hover:bg-white/10">Sign out</button>
      </form>
    </nav>
  {/if}
</header>

<main class="mx-auto max-w-5xl px-4 pt-6 pb-16">
  {@render children()}
</main>
