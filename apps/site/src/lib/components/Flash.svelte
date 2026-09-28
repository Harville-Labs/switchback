<script lang="ts">
let { error, notice }: { error?: string | null; notice?: string | null } = $props();
</script>

{#if error}<p class="flash error my-3" role="alert">{error}</p>{/if}
{#if notice}<p class="flash my-3" role="status">{notice}</p>{/if}
