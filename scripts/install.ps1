# Install Switchback on Windows, the local-first coding agent from Harville Labs.
#
#   irm https://switchback.harville.ai/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://switchback.harville.ai/install.ps1))) -VSCode
#
# Options (or environment variables, which also work with `| iex`):
#   -Version <x.y.z>   or SWITCHBACK_VERSION       a specific release (default: the latest)
#   -Dir <path>        or SWITCHBACK_INSTALL_DIR   where to put switchback.exe (default: ~\.local\bin)
#   -VSCode                                        also install the VS Code extension
#   -NoModifyPath                                  don't add the directory to your user PATH
#
# It downloads one binary from the GitHub release, checks it against the release's
# SHA256SUMS, and puts it in place, without administrator rights. Unless -NoModifyPath
# is given, it adds the directory to your user PATH (the Windows equivalent of a shell
# profile line; remove it in Settings > System > About > Advanced system settings).
#
# This is the Windows counterpart of scripts/install.sh in
# https://github.com/Harville-Labs/switchback; switchback.harville.ai serves both.
# It runs on Windows PowerShell 5.1 and PowerShell 7. SWITCHBACK_DOWNLOAD_URL and
# SWITCHBACK_RELEASES_API point it at a mirror (or a test server) instead of GitHub.

# Everything runs from the call at the bottom, so a download that's cut off
# partway through executes nothing.
function Install-Switchback {
  [CmdletBinding()]
  param(
    [string]$Version = $env:SWITCHBACK_VERSION,
    [string]$Dir = $env:SWITCHBACK_INSTALL_DIR,
    [switch]$VSCode,
    [switch]$NoModifyPath,
    [switch]$Help
  )

  $ErrorActionPreference = 'Stop'
  # Windows PowerShell's progress bar slows downloads down many times over.
  $ProgressPreference = 'SilentlyContinue'
  $releases = 'https://github.com/Harville-Labs/switchback/releases'

  function Fail([string]$message) {
    # Write-Error inside `| iex` would print a stack of script positions; keep it to one line.
    [Console]::Error.WriteLine("switchback install: $message")
    throw [System.OperationCanceledException]::new('switchback install failed')
  }

  if ($Help) {
    Write-Output @'
Install Switchback: irm https://switchback.harville.ai/install.ps1 | iex

  -Version <x.y.z>   a specific release (default: the latest)          SWITCHBACK_VERSION
  -Dir <path>        where to put switchback.exe (default: ~\.local\bin) SWITCHBACK_INSTALL_DIR
  -VSCode            also install the VS Code extension
  -NoModifyPath      don't add the directory to your user PATH

With options: & ([scriptblock]::Create((irm https://switchback.harville.ai/install.ps1))) -VSCode
'@
    return
  }

  $tmp = $null
  try {
    # $IsWindows doesn't exist in Windows PowerShell 5.1, which only runs on Windows.
    if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
      Fail 'this script is for Windows. On macOS and Linux: curl -fsSL https://switchback.harville.ai/install.sh | sh'
    }
    # Windows on Arm runs the x64 build under emulation.
    $arch = 'x64'
    if (-not [Environment]::Is64BitOperatingSystem) {
      Fail 'Switchback needs 64-bit Windows.'
    }

    $base = $env:SWITCHBACK_DOWNLOAD_URL
    if (-not $base) { $base = "$releases/download" }
    $base = $base.TrimEnd('/')
    $api = $env:SWITCHBACK_RELEASES_API
    if (-not $api) { $api = 'https://api.github.com/repos/Harville-Labs/switchback/releases' }
    if ($base -notmatch '^https?://') {
      Fail "SWITCHBACK_DOWNLOAD_URL must be an http(s) URL, not $base"
    }
    # Plain http only when the server itself was given as http:// (a local test server).
    $httpsOnly = $base.StartsWith('https://')
    # Windows PowerShell 5.1 doesn't offer TLS 1.2 by default, and GitHub requires it.
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # Returns whether <url> was saved to <out>.
    function TryFetch([string]$url, [string]$out) {
      if ($httpsOnly -and -not $url.StartsWith('https://')) { Fail "refusing to download $url over http" }
      try {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -MaximumRedirection 5
        return $true
      } catch {
        return $false
      }
    }
    function Fetch([string]$url, [string]$out) {
      if (-not (TryFetch $url $out)) { Fail "couldn't download $url. Check your connection and try again." }
    }

    # Verify <dir>\<file> against <dir>\SHA256SUMS.
    function Verify([string]$dir, [string]$file) {
      $expected = $null
      foreach ($line in Get-Content -LiteralPath (Join-Path $dir 'SHA256SUMS')) {
        $parts = $line -split '\s+', 2
        if ($parts.Count -eq 2 -and ($parts[1] -eq $file -or $parts[1] -eq "*$file")) {
          $expected = $parts[0].ToLowerInvariant()
          break
        }
      }
      if (-not $expected) { Fail "release $Version lists no checksum for $file." }
      # Not Get-FileHash: Windows PowerShell can't load it when started from PowerShell 7,
      # whose module path it inherits.
      $sha = [Security.Cryptography.SHA256]::Create()
      $stream = [IO.File]::OpenRead((Join-Path $dir $file))
      try {
        $actual = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
      } finally {
        $stream.Dispose()
        $sha.Dispose()
      }
      if ($actual -ne $expected) {
        Fail "$file doesn't match its checksum (expected $expected, got $actual). Nothing was installed; try again."
      }
    }

    if (-not $Dir) { $Dir = Join-Path $HOME '.local\bin' }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("switchback-" + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    if (-not $Version) {
      # The newest release, prereleases included (GitHub's "latest" skips them,
      # and every 0.x release is one).
      try {
        $list = Invoke-RestMethod -Uri "$($api)?per_page=1" -UseBasicParsing
      } catch {
        Fail "couldn't look up the latest release (GitHub's API allows 60 lookups an hour per address). Choose one with -Version; see $releases."
      }
      $Version = @($list)[0].tag_name
      if (-not $Version) { Fail "found no Switchback releases at $api." }
    }
    $Version = $Version -replace '^v', ''
    if ($Version -notmatch '^\d+\.\d+\.\d+') {
      Fail "`"$Version`" isn't a Switchback version (expected something like 0.5.0)."
    }

    $file = "switchback-$Version-windows-$arch.exe"
    Write-Output "Downloading Switchback $Version for windows-$arch"
    if (-not (TryFetch "$base/v$Version/SHA256SUMS" (Join-Path $tmp 'SHA256SUMS'))) {
      Fail "couldn't find Switchback $Version. See $releases for releases."
    }
    Fetch "$base/v$Version/$file" (Join-Path $tmp $file)
    Verify $tmp $file

    try {
      New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    } catch {
      Fail "can't write to $Dir. Choose a directory you own with -Dir."
    }
    $target = Join-Path $Dir 'switchback.exe'
    try {
      Move-Item -LiteralPath (Join-Path $tmp $file) -Destination $target -Force
    } catch {
      Fail "can't replace $target. If Switchback is running (including in VS Code), close it and try again."
    }
    $installed = $null
    $global:LASTEXITCODE = 0
    try { $installed = (& $target --version 2>$null | Out-String).Trim() } catch {}
    if ($LASTEXITCODE -ne 0 -or -not $installed) {
      Fail "$target was installed but doesn't run. Please report this with the output of: & '$target' --version"
    }
    Write-Output "Installed Switchback $installed to $target"

    if ($VSCode) {
      $vsix = "switchback-vscode-$Version-win32-$arch.vsix"
      Write-Output "Downloading the VS Code extension ($vsix)"
      Fetch "$base/v$Version/$vsix" (Join-Path $tmp $vsix)
      Verify $tmp $vsix
      $editor = $null
      foreach ($name in 'code', 'code-insiders', 'codium', 'cursor') {
        $editor = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($editor) { break }
      }
      if ($editor) {
        & $editor.Source --install-extension (Join-Path $tmp $vsix) --force | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Fail "$($editor.Name) couldn't install the extension. Install $base/v$Version/$vsix from VS Code's Extensions view (... > Install from VSIX)."
        }
        Write-Output "Installed the extension in $($editor.Name)."
      } else {
        Write-Output "No VS Code command line (code) found. Download $base/v$Version/$vsix and"
        Write-Output 'install it from the Extensions view (... > Install from VSIX).'
      }
    }

    $full = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
    $onPath = { param($value) @($value -split ';' | ForEach-Object { $_.TrimEnd('\') }) -contains $full }
    if (-not $NoModifyPath) {
      # Read and write the raw registry value: [Environment]::SetEnvironmentVariable
      # would expand %VARIABLES% in the user's PATH and store it as a plain string.
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      try {
        $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (-not (& $onPath $userPath)) {
          $joined = if ($userPath) { "$full;$userPath" } else { $full }
          $key.SetValue('Path', $joined, [Microsoft.Win32.RegistryValueKind]::ExpandString)
          # Setting any variable this way broadcasts the change, so new terminals see the PATH.
          [Environment]::SetEnvironmentVariable('SWITCHBACK_INSTALL_PATH_CHANGED', '1', 'User')
          [Environment]::SetEnvironmentVariable('SWITCHBACK_INSTALL_PATH_CHANGED', $null, 'User')
          Write-Output "Added $full to your user PATH. Open a new terminal to use it."
        }
      } finally {
        $key.Close()
      }
      if (-not (& $onPath $env:Path)) { $env:Path = "$full;$env:Path" }
    } elseif (-not (& $onPath $env:Path)) {
      Write-Output ''
      Write-Output "$full isn't on your PATH. Add it in Settings, or run:"
      Write-Output "  [Environment]::SetEnvironmentVariable('Path', `"$full;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
    }

    $found = Get-Command switchback -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found -and [IO.Path]::GetFullPath($found.Source) -ne [IO.Path]::GetFullPath($target)) {
      Write-Output ''
      Write-Output "Note: $($found.Source) comes first on your PATH, so ``switchback`` runs that copy. Remove it, or put $full first."
    }
    Write-Output ''
    Write-Output 'Next: run `switchback init` to choose your models, then `switchback` in a project.'
  } catch [System.OperationCanceledException] {
    # Already explained by Fail. Exit with an error when run as a script; under
    # `| iex`, exiting would close the user's terminal, so just stop.
    if ($MyInvocation.ScriptName -or $PSCommandPath) { exit 1 }
  } finally {
    if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

try {
  Install-Switchback @args
} catch {
  # An unknown option or a bad value: say so on one line and fail when run as a file.
  [Console]::Error.WriteLine("switchback install: $($_.Exception.Message) (see -Help)")
  if ($PSCommandPath) { exit 1 }
}
