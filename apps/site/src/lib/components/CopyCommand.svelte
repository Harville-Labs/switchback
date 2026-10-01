<script lang="ts">
let {
  command,
  label = 'Copy',
  quiet = false,
}: { command: string; label?: string; quiet?: boolean } = $props();
const id = $props.id();
let copied = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    // No clipboard access (an insecure origin, or permission denied): select
    // the text so the visitor can copy it themselves.
    const code = document.getElementById(id);
    if (code) getSelection()?.selectAllChildren(code);
    return;
  }
  copied = true;
  clearTimeout(timer);
  timer = setTimeout(() => (copied = false), 2000);
}
</script>

<div class="command" class:command-quiet={quiet}>
  <code {id}>{command}</code>
  <button type="button" class:copied onclick={copy} aria-label="{label}: {command}">
    {copied ? 'Copied' : label}
  </button>
  <span class="sr-only" aria-live="polite">{copied ? 'Copied to the clipboard' : ''}</span>
</div>
