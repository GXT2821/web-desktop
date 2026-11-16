param(
  [string]$Source = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist\win-unpacked'),
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\文档库'),
  [switch]$PackagedLauncher,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
# 避免在 DSH/CI 环境里被当成 Node 运行
$env:ELECTRON_RUN_AS_NODE = $null
$root = Split-Path $PSScriptRoot -Parent
$exeName = '文档库.exe'
$exePath = Join-Path $InstallDir $exeName
$iconPath = Join-Path $InstallDir 'icon-app-f.ico'
# 快捷方式/卸载项用一个新文件名，绕开 Explorer 按路径缓存的旧图标
$shortcutIcon = Join-Path $InstallDir 'app-icon-f.ico'

if (-not (Test-Path $Source)) {
  throw "找不到构建目录：$Source（先执行 npm run build:win，或解压绿色版后指定 -Source）"
}

Write-Host "安装源：$Source"
Write-Host "安装到：$InstallDir"

# 停止正在运行的旧版本
Get-Process '文档库' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 30; $i++) {
  if (-not (Get-Process '文档库' -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 300
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
robocopy $Source $InstallDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制文件失败（robocopy exit $LASTEXITCODE）" }

# 默认替换为原版 Electron 启动器：打包改写过的 exe 在启用 Application Control 的机器上会被拦截
if (-not $PackagedLauncher) {
  $original = Join-Path $root 'node_modules\electron\dist\electron.exe'
  if (Test-Path $original) {
    Copy-Item $original $exePath -Force
    Write-Host '启动器：原版 Electron（兼容 Application Control）'
  } else {
    Write-Host '启动器：使用打包 exe（未找到原版 Electron）'
  }
}

# 图标：优先使用仓库里的新图标；绿色版里若没有，就保留打包自带的
$repoIcon = Join-Path $root 'build\icon.ico'
if (Test-Path $repoIcon) {
  Copy-Item $repoIcon $iconPath -Force
  Copy-Item $repoIcon $shortcutIcon -Force
}

# 卸载脚本（自包含，不依赖仓库）
$uninstallCmd = @'
@echo off
chcp 65001 >nul
setlocal
title 卸载 文档库
set "DIR=%~dp0"
echo.
echo 正在卸载 文档库 ...
taskkill /f /im "文档库.exe" >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.gt.docvault" /f >nul 2>&1
del /f /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\文档库.lnk" >nul 2>&1
del /f /q "%USERPROFILE%\Desktop\文档库.lnk" >nul 2>&1
echo.
set /p REMOVE_DATA=是否同时删除用户数据（文档库、会话、下载记录）？输入 y 确认，直接回车保留：
if /i "%REMOVE_DATA%"=="y" (
  rmdir /s /q "%APPDATA%\DocVault"
  echo 用户数据已删除。
) else (
  echo 用户数据已保留：%APPDATA%\DocVault
)
echo 3 秒后删除程序目录...
start "" cmd /c ping -n 4 127.0.0.1 ^>nul ^& rmdir /s /q "%DIR%"
exit /b 0
'@
# cmd 用 UTF-8 + chcp 65001；不写 BOM，避免首行出现乱码字符
[System.IO.File]::WriteAllText((Join-Path $InstallDir 'uninstall.cmd'), ($uninstallCmd -replace "`r?`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

# 快捷方式
$ws = New-Object -ComObject WScript.Shell
$shortcuts = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\文档库.lnk'),
  (Join-Path $env:USERPROFILE 'Desktop\文档库.lnk')
)
foreach ($lnkPath in $shortcuts) {
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = $exePath
  $lnk.WorkingDirectory = $InstallDir
  $lnk.IconLocation = "$shortcutIcon,0"
  $lnk.Description = '文档库 · 在线文档收藏'
  $lnk.Save()
}

# 卸载项（当前用户，无需管理员）
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.gt.docvault'
if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }
$version = '未知'
$pkg = Join-Path $root 'package.json'
if (Test-Path $pkg) { $version = (Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).version }
Set-ItemProperty $key -Name DisplayName -Value "文档库 $version"
Set-ItemProperty $key -Name DisplayVersion -Value $version
Set-ItemProperty $key -Name DisplayIcon -Value $shortcutIcon
Set-ItemProperty $key -Name InstallLocation -Value $InstallDir
Set-ItemProperty $key -Name UninstallString -Value "cmd /c `"$InstallDir\uninstall.cmd`""
Set-ItemProperty $key -Name Publisher -Value 'guo-tao'
Set-ItemProperty $key -Name NoModify -Value 1 -Type DWord
Set-ItemProperty $key -Name NoRepair -Value 1 -Type DWord

Start-Process -FilePath "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList '-show' -Wait -ErrorAction SilentlyContinue

Write-Host "已安装 $version 到 $InstallDir"
if (-not $NoLaunch) {
  Start-Process -FilePath $exePath
  Write-Host '已启动文档库'
}