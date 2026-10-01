<script lang="ts">
import { page } from '$app/state';
</script>

<svelte:head><title>{page.status} · Switchback</title></svelte:head>

<section class="mx-auto mt-10 max-w-md">
  <h1 class="mb-2 page-title">{page.status === 404 ? 'Not found' : page.status === 403 ? 'Not allowed' : 'Something went wrong'}</h1>
  <p class="mb-4">{page.error?.message}</p>
  <a href="/" class="btn quiet no-underline">Home</a>
</section>
