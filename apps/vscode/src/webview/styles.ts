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
  .user { margin: 16px 0 10px; padding: 7px 11px; border-radius: 8px; white-space: pre-wrap; line-height: 1.45; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  #log > .user:first-child { margin-top: 4px; }
  .assistant { white-space: pre-wrap; margin: 6px 0; line-height: 1.55; }
  .assistant.md { white-space: normal; }
  .md p { margin: 6px 0; } .md ul, .md ol { margin: 6px 0; padding-left: 20px; } .md li { margin: 2px 0; }
  .md h1, .md h2, .md h3 { font-size: 1.05em; margin: 12px 0 4px; }
  .md code { font-family: var(--vscode-editor-font-family); font-size: .92em; background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 4px; }
  .md table { border-collapse: collapse; margin: 6px 0; } .md td, .md th { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; }
  .md a { color: var(--vscode-textLink-foreground); text-decoration: none; } .md a:hover { text-decoration: underline; }
  .md blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--vscode-descriptionForeground); }
  .code { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 8px 0; overflow: hidden; background: var(--vscode-textCodeBlock-background); }
  .code-bar { display: flex; justify-content: space-between; align-items: center; padding: 3px 8px; font-size: .8em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
  .code pre { margin: 0; padding: 8px 10px; overflow-x: auto; } .code pre code { background: none; padding: 0; }
  button.link { background: none; border: none; color: var(--vscode-textLink-foreground); padding: 0 4px; }
  .reasoning { color: var(--vscode-descriptionForeground); font-style: italic; white-space: pre-wrap; margin: 6px 0; }
  .route { display: inline-flex; align-items: center; gap: 5px; font-size: .8em; color: var(--vscode-descriptionForeground); margin: 8px 0 2px; }
  .route::before { content: ""; width: 6px; height: 6px; border-radius: 50%; }
  .route.local::before { background: var(--vscode-charts-green); } .route.remote::before { background: var(--vscode-charts-yellow); }
  .tool, .subagent { font-family: var(--vscode-editor-font-family); font-size: .88em; margin: 3px 0; }
  details.subagent > summary { cursor: pointer; list-style: none; }
  details.subagent > summary::-webkit-details-marker { display: none; }
  details.subagent > .children { margin: 4px 0 8px 6px; padding-left: 10px; border-left: 2px solid var(--vscode-panel-border); }
  .ok { color: var(--vscode-charts-green); } .error { color: var(--vscode-errorForeground); } .running { color: var(--vscode-charts-yellow); }
  .detail { color: var(--vscode-descriptionForeground); margin-left: 1.4em; white-space: pre-wrap; }
  .info { color: var(--vscode-descriptionForeground); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: .88em; margin: 6px 0; padding: 2px 0 2px 10px; border-left: 2px solid var(--vscode-panel-border); }
  .tool .private { color: var(--vscode-charts-blue); font-size: 0.9em; }
  .review { margin: 6px 0; }
  .review.skipped { color: var(--vscode-descriptionForeground); }
  .review ul { margin: 2px 0 2px 1.4em; padding: 0; }
  .review li.bug { color: var(--vscode-errorForeground); }
  .review li.nit { color: var(--vscode-descriptionForeground); }
  .diff { font-family: var(--vscode-editor-font-family); font-size: .85em; max-height: 45vh; overflow: auto; margin: 8px 0; white-space: pre; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .diff .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,160,0,.15)); }
  .diff .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(200,0,0,.15)); }
  .diff .hunk { color: var(--vscode-textLink-foreground); opacity: .8; }

  /* Permission and escalation prompts */
  .prompt { margin: 0 12px 8px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); line-height: 1.45; }
  .prompt .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .prompt .estimate { color: var(--vscode-charts-yellow); }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 4px; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

  /* Composer */
  footer { padding: 4px 12px 10px; }
  .composer { position: relative; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 10px; background: var(--vscode-input-background); padding: 6px 6px 4px 10px; }
  .composer:focus-within { border-color: var(--vscode-focusBorder); }
  textarea { display: block; width: 100%; box-sizing: border-box; resize: none; min-height: 22px; max-height: 40vh; overflow-y: auto; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; padding: 4px 4px 4px 0; font: inherit; line-height: 1.45; }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 2px; }
  .toolbar .side { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .icon { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; padding: 0 4px; border: none; border-radius: 6px; background: transparent; color: var(--vscode-descriptionForeground); }
  .icon:hover, .icon.on { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  .icon svg { width: 16px; height: 16px; }
  #status { font-size: .8em; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 4px; }
  .send { width: 26px; height: 26px; border-radius: 50%; border: none; display: inline-flex; align-items: center; justify-content: center; background: var(--vscode-button-background); color: var(--vscode-button-foreground); flex: none; }
  .send:hover { background: var(--vscode-button-hoverBackground); }
  .send:disabled { opacity: .4; cursor: default; }
  .send svg { width: 14px; height: 14px; }

  /* Attachable editor context */
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chips:not(:empty) { margin: 0 0 4px; }
  .chip { font-size: .8em; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-descriptionForeground); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 6px; font-size: .8em; }
  .controls:empty { display: none; }
  .segmented { display: inline-flex; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; }
  .segmented button { background: transparent; color: var(--vscode-descriptionForeground); border: none; border-radius: 0; padding: 2px 8px; }
  .segmented button.on { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .pill { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 2px 8px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill:hover, .segmented button:hover { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
  .pill .k { color: var(--vscode-descriptionForeground); }
  .pill .here { font-weight: 600; color: var(--vscode-charts-yellow); }
`;
