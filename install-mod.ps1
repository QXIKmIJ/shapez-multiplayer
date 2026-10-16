# =====================================================================
# Shapez Multiplayer Mod Installer
# =====================================================================
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceMod = Join-Path $projectDir "mod\multiplay.js"

if (-not (Test-Path $sourceMod)) {
    Write-Host "[ОШИБКА] Файл мода не найден: $sourceMod" -ForegroundColor Red
    exit 1
}

$appData = [Environment]::GetFolderPath('ApplicationData')
$targetDir = Join-Path $appData "shapez.io\mods"

if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

$destFile = Join-Path $targetDir "multiplay.js"
Copy-Item -Path $sourceMod -Destination $destFile -Force

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "         Мод Shapez Multiplayer успешно установлен!       " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Путь установки: $destFile" -ForegroundColor Yellow
Write-Host ""
Write-Host "Инструкция по использованию:" -ForegroundColor White
Write-Host " 1. Запустите Shapez (Steam или Portable сборку)." -ForegroundColor Gray
Write-Host " 2. В главном меню появится кнопка 'Мультиплеер'." -ForegroundColor Gray
Write-Host " 3. Запустите сервер (start-server.bat или shapez-multiplayer-server.exe)." -ForegroundColor Gray
Write-Host " 4. ХОСТ: нажмите 'Открыть текущий мир' и передайте код (MPZ2:...) другу." -ForegroundColor Gray
Write-Host " 5. КЛИЕНТ: нажмите 'Подключиться к другу', вставьте код и стройте вместе!" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan
