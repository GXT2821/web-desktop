param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\文档库'),
  [switch]$RemoveUserData,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:APPDATA 'DocVault'

if (-not $Quiet -and -not $RemoveUserData) {
  $answer = Read-Host '是否同时删除用户数据（文档库、会话、下载记录）？输入 y 确认，直接回车保留'
  if ($answer -match '^(y|yes)$') { $RemoveUserData = $true }
}

Get-Process '文档库' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

foreach ($lnk in @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\文档库.lnk'),
  (Join-Path $env:USERPROFILE 'Desktop\文档库.lnk')
)) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force }
}

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.gt.docvault'
if (Test-Path $key) { Remove-Item $key -Recurse -Force }

if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }

if ($RemoveUserData -and (Test-Path $dataDir)) {
  Remove-Item $dataDir -Recurse -Force
  Write-Host "已删除用户数据：$dataDir"
} else {
  Write-Host "用户数据保留在：$dataDir"
}

Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList '-show' -Wait -ErrorAction SilentlyContinue
Write-Host '卸载完成。'