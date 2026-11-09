# Creates the Desktop and Start menu shortcuts. Called by setup.bat. (ASCII only on purpose)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'assets\icon.ico'

if (-not (Test-Path $electron)) {
  Write-Host 'electron.exe not found. Run npm install first.'
  exit 1
}

# Build the Korean name from char codes to avoid file-encoding problems
$name = -join ([char]0xB0B4, ' ', [char]0xD50C, [char]0xB798, [char]0xB108)

$ws = New-Object -ComObject WScript.Shell
$targets = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)

foreach ($dir in $targets) {
  $lnk = $ws.CreateShortcut((Join-Path $dir ($name + '.lnk')))
  $lnk.TargetPath = $electron
  $lnk.Arguments = '"' + $root + '"'
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = $icon
  $lnk.Description = 'Calendar and todo planner'
  $lnk.Save()
  Write-Host ('Created: ' + $lnk.FullName)
}
