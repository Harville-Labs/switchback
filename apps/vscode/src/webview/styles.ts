/**
 * Chat webview styles. Every color is a VS Code theme variable, so the view
 * follows the user's theme (light, dark, high contrast) without its own palette.
 */
export const STYLES = `
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  #app { display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 10px 14px 14px; }
  button { font: inherit; cursor: pointer; }
  .dim { color: var(--vscode-descriptionForeground); }

  /* Empty session */
  .welcome { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; margin: 12vh auto 18px; max-width: 320px; }
  .welcome svg { width: 36px; height: 36px; color: var(--vscode-textLink-foreground); }
  .welcome h1 { font-size: 1.25em; font-weight: 600; margin: 4px 0 0; }
  .welcome p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.5; }
  .welcome .keys { margin-top: 10px; display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 14px; font-size: .9em; color: var(--vscode-descriptionForeground); }
  kbd { font-family: var(--vscode-editor-font-family); font-size: .9em; padding: 0 5px; border-radius: 4px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); background: var(--vscode-keybindingLabel-background, transparent); color: var(--vscode-keybindingLabel-foreground, inherit); }

  /* Transcript */
  .user { margin: 20px 0 12px; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; line-height: 1.45; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  #log > .user:first-child { margin-top: 4px; }
  .assistant { white-space: pre-wrap; margin: 10px 0; line-height: 1.55; }
  .assistant.md { white-space: normal; }
  .md p { margin: 8px 0; } .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; } .md ul, .md ol { margin: 6px 0; padding-left: 20px; } .md li { margin: 2px 0; }
  .md h1, .md h2, .md h3 { font-size: 1.05em; margin: 12px 0 4px; }
  .md code { font-family: var(--vscode-editor-font-family); font-size: .92em; background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 4px; }
  .md table { border-collapse: collapse; margin: 6px 0; } .md td, .md th { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; }
  .md a { color: var(--vscode-textLink-foreground); text-decoration: none; } .md a:hover { text-decoration: underline; }
  .md blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--vscode-descriptionForeground); }
  .code { border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin: 10px 0; overflow: hidden; background: var(--vscode-textCodeBlock-background); }
  .code-bar { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px 3px 10px; font-size: .75em; letter-spacing: .03em; text-transform: lowercase; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
  .code-bar button.link { color: var(--vscode-descriptionForeground); padding: 1px 6px; border-radius: 4px; }
  .code-bar button.link:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .code pre { margin: 0; padding: 10px 12px; line-height: 1.5; overflow-x: auto; } .code pre code { background: none; padding: 0; }
  button.link { background: none; border: none; color: var(--vscode-textLink-foreground); padding: 0 4px; }
  .image { display: block; width: fit-content; margin: 6px 0; font-size: .85em; color: var(--vscode-descriptionForeground); }
  .image img { max-width: 160px; max-height: 120px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); object-fit: cover; }
  details.thinking { margin: 4px 0 6px; color: var(--vscode-descriptionForeground); }
  details.thinking > summary { cursor: pointer; list-style: none; font-size: .88em; user-select: none; }
  details.thinking > summary::-webkit-details-marker { display: none; }
  details.thinking > summary:hover { color: var(--vscode-foreground); }
  details.thinking > summary::after { content: ' ›'; }
  details.thinking[open] > summary::after { content: ' ⌄'; }
  .reasoning { font-style: italic; white-space: pre-wrap; margin: 4px 0 8px 6px; padding-left: 10px; border-left: 2px solid var(--vscode-panel-border); line-height: 1.5; }
  .route { display: flex; align-items: center; gap: 6px; font-size: .8em; color: var(--vscode-descriptionForeground); margin: 4px 0 6px; }
  .route::before { content: ""; width: 6px; height: 6px; border-radius: 50%; }
  .route.local::before { background: var(--vscode-charts-green); } .route.remote::before { background: var(--vscode-charts-yellow); }
  /* Answers that follow tool work get room, so the two don't read as one block. */
  :is(.tool, .detail, .output, details.explore, details.subagent) + .assistant { margin-top: 14px; }
  .tool, .subagent { font-family: var(--vscode-editor-font-family); font-size: .88em; margin: 4px 0; line-height: 1.5; }
  details.subagent > summary { cursor: pointer; list-style: none; }
  details.subagent > summary::-webkit-details-marker { display: none; }
  details.subagent > .children { margin: 4px 0 8px 6px; padding-left: 10px; border-left: 2px solid var(--vscode-panel-border); }
  .ok { color: var(--vscode-charts-green); } .error { color: var(--vscode-errorForeground); } .running { color: var(--vscode-charts-yellow); }
  .detail { color: var(--vscode-descriptionForeground); margin-left: 1.4em; white-space: pre-wrap; }
  .info { color: var(--vscode-descriptionForeground); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: .88em; margin: 6px 0; padding: 2px 0 2px 10px; border-left: 2px solid var(--vscode-panel-border); }
  .tool .private { color: var(--vscode-charts-blue); font-size: 0.9em; }
  .tool + .detail { margin-left: 1.4em; font-size: .85em; }
  .output { font-family: var(--vscode-editor-font-family); font-size: .82em; white-space: pre; overflow-x: auto; color: var(--vscode-descriptionForeground); margin: 2px 0 6px 2.4em; }
  details.tool-diff { margin-left: 1.4em; font-size: .85em; }
  details.tool-diff > summary, details.explore > summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
  details.explore { font-family: var(--vscode-editor-font-family); font-size: .88em; margin: 4px 0; line-height: 1.5; }
  details.explore > summary { list-style: none; color: inherit; }
  details.explore > summary::-webkit-details-marker { display: none; }
  details.explore ul { margin: 2px 0 6px 1.4em; padding: 0; list-style: none; }
  .detail-inline { color: var(--vscode-descriptionForeground); }
  .prompt .feedback { display: flex; gap: 6px; margin-top: 8px; }
  .prompt .feedback input { flex: 1; font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 8px; }
  .prompt .feedback input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .review { margin: 6px 0; }
  .review.skipped { color: var(--vscode-descriptionForeground); }
  .review ul { margin: 2px 0 2px 1.4em; padding: 0; }
  .review li.bug { color: var(--vscode-errorForeground); }
  .review li.nit { color: var(--vscode-descriptionForeground); }
  .diff { font-family: var(--vscode-editor-font-family); font-size: .85em; line-height: 1.5; max-height: 45vh; overflow: auto; margin: 8px 0; padding: 4px 0; white-space: pre; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); }
  .diff > * { padding: 0 8px; }
  .diff .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,160,0,.15)); }
  .diff .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(200,0,0,.15)); }
  .diff .hunk { color: var(--vscode-textLink-foreground); opacity: .8; }

  /* Permission and escalation prompts */
  .prompt { margin: 0 12px 8px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.2)); line-height: 1.45; }
  .prompt .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .prompt .estimate { color: var(--vscode-charts-yellow); }
  .prompt .hint { color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .prompt .hint::first-letter { text-transform: uppercase; }
  .prompt.plan { max-height: 50vh; overflow-y: auto; }
  .prompt .plan-title { font-weight: 600; margin-bottom: 4px; }
  .todos { margin: 0 12px 6px; padding: 8px 12px; border-radius: 8px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
  .goal { margin: 0 12px 6px; padding: 4px 12px; color: var(--vscode-textLink-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .todo { line-height: 1.6; }
  .todo.done { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
  .todo.in_progress { font-weight: 600; color: var(--vscode-textLink-foreground); }
  .queued { display: flex; gap: 8px; align-items: center; margin: 0 12px 6px; padding: 5px 12px; border-radius: 999px; background: var(--vscode-editorWidget-background); border: 1px dashed var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: .92em; }
  .queued .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .queued .link { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; }
  .btn.now { margin-right: 6px; padding: 2px 10px; font-size: .9em; border: 1px solid var(--vscode-button-background); background: transparent; color: var(--vscode-foreground); }
  .btn.now:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, transparent); padding: 4px 12px; border-radius: 4px; line-height: 18px; cursor: pointer; }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

  /* Composer */
  footer { padding: 4px 12px 10px; }
  .composer { position: relative; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 10px; background: var(--vscode-input-background); padding: 8px 8px 6px 12px; box-shadow: 0 1px 6px var(--vscode-widget-shadow, rgba(0,0,0,.18)); transition: border-color .15s, box-shadow .15s; }
  .composer:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 2px 10px var(--vscode-widget-shadow, rgba(0,0,0,.22)); }
  textarea { display: block; width: 100%; box-sizing: border-box; resize: none; min-height: 22px; max-height: 40vh; overflow-y: auto; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; padding: 4px 4px 4px 0; font: inherit; line-height: 1.45; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 2px; }
  .toolbar .side { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .icon { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; padding: 0 4px; border: none; border-radius: 6px; background: transparent; color: var(--vscode-descriptionForeground); }
  .icon:hover, .icon.on { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .icon svg { width: 16px; height: 16px; }
  #status { font-size: .8em; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 4px; }
  .send { position: relative; width: 28px; height: 28px; border-radius: 6px; border: none; display: inline-flex; align-items: center; justify-content: center; background: var(--vscode-button-background); color: var(--vscode-button-foreground); flex: none; cursor: pointer; transition: background .15s, transform .1s, opacity .15s; }
  .send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .send:active:not(:disabled) { transform: scale(.94); }
  .send:disabled { background: transparent; color: var(--vscode-descriptionForeground); box-shadow: inset 0 0 0 1px var(--vscode-panel-border); cursor: default; }
  .send svg { width: 15px; height: 15px; }
  /* While the model works: an X inside a slowly pulsing ring. */
  .send.stop { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .send.stop::after { content: ''; position: absolute; inset: -3px; border-radius: 8px; border: 2px solid var(--vscode-button-background); opacity: .6; animation: sb-pulse 1.4s ease-in-out infinite; }
  @keyframes sb-pulse { 0%, 100% { transform: scale(.92); opacity: .25; } 50% { transform: scale(1.04); opacity: .7; } }
  @media (prefers-reduced-motion: reduce) { .send.stop::after { animation: none; } }

  /* Attachable editor context */
  .images { display: flex; flex-wrap: wrap; gap: 6px; }
  .images:not(:empty) { margin: 0 0 6px; }
  .pending-image { position: relative; }
  .pending-image img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid var(--vscode-panel-border); display: block; }
  .pending-image .remove { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; padding: 0; font-size: 10px; line-height: 18px; cursor: pointer; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chips:not(:empty) { margin: 0 0 4px; }
  .chip { font-size: .8em; padding: 1px 8px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-descriptionForeground); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.on { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-color: transparent; }

  /* Slash command menu */
  .menu { position: absolute; left: -1px; right: -1px; bottom: calc(100% + 6px); max-height: min(50vh, 340px); overflow-y: auto; padding: 4px; border-radius: 8px; z-index: 10; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); color: var(--vscode-quickInput-foreground, inherit); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0,0,0,.3)); }
  .menu[hidden] { display: none; }
  .menu-group { font-size: .72em; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); padding: 8px 8px 3px; }
  .menu-group:first-child { padding-top: 4px; }
  .menu-item { display: flex; align-items: baseline; gap: 10px; padding: 4px 8px; border-radius: 5px; cursor: pointer; }
  .menu-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .menu-item:not(.active):hover { background: var(--vscode-list-hoverBackground); }
  .menu-name { font-family: var(--vscode-editor-font-family); white-space: nowrap; flex: none; }
  .menu-args { opacity: .6; }
  .menu-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9em; opacity: .7; }
  .menu-empty { padding: 8px; color: var(--vscode-descriptionForeground); }

  /* Routing and roles, under the composer */
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin-top: 4px; font-size: .8em; }
  .controls:empty { display: none; }
  .segmented { display: inline-flex; gap: 1px; padding: 1px; margin-right: 4px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; }
  .segmented button { background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid transparent; border-radius: 4px; padding: 1px 8px; }
  .segmented button.on { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .pill { background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; border-radius: 4px; padding: 2px 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill:hover, .segmented button:not(.on):hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .pill:focus-visible, .segmented button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .pill .k { color: var(--vscode-descriptionForeground); }
  .pill .here { font-weight: 600; color: var(--vscode-charts-yellow); }
  .pill.model { display: inline-flex; align-items: center; gap: 4px; padding: 0 2px 0 6px; }
  .pill.model select { font: inherit; color: var(--vscode-foreground); background: transparent; border: none; padding: 2px 2px; max-width: 220px; text-overflow: ellipsis; cursor: pointer; }
  .pill.model select:focus { outline: 1px solid var(--vscode-focusBorder); border-radius: 4px; }
  .pill.model option { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }

  /* Tabs and the sessions dashboard */
  .tabs { display: flex; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: .85em; }
  .tabs:empty { display: none; }
  .tablist { display: flex; gap: 2px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .tab { display: inline-flex; align-items: center; gap: 5px; max-width: 180px; min-width: 0; padding: 3px 6px 3px 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--vscode-descriptionForeground); }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .tab.on { background: var(--vscode-tab-activeBackground, var(--vscode-input-background)); border-color: var(--vscode-panel-border); color: var(--vscode-foreground); }
  .tab .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab .dot { width: 1em; text-align: center; flex: none; }
  .tab .x { display: inline-flex; opacity: 0; border-radius: 4px; }
  .tab:hover .x, .tab.on .x, .tab:focus-visible .x { opacity: .8; }
  .tab .x:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
  .tab .x svg { width: 12px; height: 12px; }
  .waiting .dot, .state.waiting { color: var(--vscode-charts-yellow); }
  .running .dot, .state.running { color: var(--vscode-charts-blue); }
  .failed .dot, .state.failed { color: var(--vscode-errorForeground); }
  .done .dot, .state.done { color: var(--vscode-charts-green); }
  .tabs .icon.on { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .tabs .badge { margin-left: 2px; font-size: .8em; padding: 0 4px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .dash { flex: 1; overflow-y: auto; padding: 10px 14px; }
  .dash-head { display: flex; align-items: center; justify-content: space-between; }
  .dash-head { margin-bottom: 8px; }
  .dash h2 { font-size: 1.05em; margin: 4px 0; } .dash h3 { font-size: .72em; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; margin: 18px 0 6px; color: var(--vscode-descriptionForeground); }
  .cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .card { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; transition: background .1s; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card .btn { padding: 2px 10px; font-size: .9em; }
  .card.on { border-color: var(--vscode-focusBorder); }
  .card .open { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; background: transparent; border: none; color: inherit; padding: 0; }
  .card .title { font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .n { display: inline-block; min-width: 1.4em; margin-right: 4px; color: var(--vscode-descriptionForeground); font-weight: normal; }
  .card .facts, .card .agent { font-size: .85em; color: var(--vscode-descriptionForeground); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card .local { color: var(--vscode-charts-green); } .card .remote { color: var(--vscode-charts-yellow); }
  .card .actions { display: flex; gap: 4px; flex: none; }
  .dash .hint { margin-top: 12px; font-size: .85em; color: var(--vscode-descriptionForeground); }
`;
