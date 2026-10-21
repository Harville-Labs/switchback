# iTerm2: let Switchback have Ctrl+Tab and Ctrl+Shift+Tab

iTerm2 uses both to switch its own tabs, so they never reach a program running inside it. iTerm2 keeps key bindings in its settings rather than a text file, so this takes a few clicks. A key mapping in your profile comes before iTerm2's tab switching, so map each key to the sequence Switchback reads:

1. Open **Settings → Profiles**, pick the profile you use, and go to the **Keys → Key Mappings** tab.
2. Click **+**, press **Ctrl+Tab** in the shortcut field, choose **Send Escape Sequence** as the action, type `[9;5u`, and click **OK**.
3. Click **+** again, press **Ctrl+Shift+Tab**, choose **Send Escape Sequence**, type `[9;6u`, and click **OK**.

iTerm2 adds the Esc in front, so the terminal sends `Esc [9;5u` and `Esc [9;6u`, the same thing a terminal speaking kitty's keyboard protocol sends. This works whether or not that protocol is on.

If Ctrl+Tab still switches iTerm2's tabs, look in **Settings → Keys → Key Bindings** for a Ctrl+Tab or Ctrl+Shift+Tab entry and remove it with **−**.
