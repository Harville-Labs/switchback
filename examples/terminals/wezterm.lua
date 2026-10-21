-- WezTerm: let Switchback have Ctrl+Tab and Ctrl+Shift+Tab.
--
-- WezTerm uses both to switch its own tabs, so they never reach a program
-- running inside it. Add these lines to ~/.wezterm.lua (or merge them into
-- your config), then reload with Ctrl+Shift+R.
local wezterm = require 'wezterm'
local act = wezterm.action
local config = wezterm.config_builder()

-- WezTerm speaks kitty's keyboard protocol only when this is on. Without it,
-- Ctrl+Tab arrives as a plain Tab.
config.enable_kitty_keyboard = true

config.keys = {
  { key = 'Tab', mods = 'CTRL', action = act.DisableDefaultAssignment },
  { key = 'Tab', mods = 'CTRL|SHIFT', action = act.DisableDefaultAssignment },
}

return config
