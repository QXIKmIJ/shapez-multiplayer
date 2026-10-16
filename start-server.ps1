# =====================================================================
# Shapez Multiplayer Server Launcher
# =====================================================================
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$exePath = Join-Path $projectDir "shapez-multiplayer-server.exe"

# Detect network interfaces
$localIps = @()
$tailscaleIps = @()
$radminIps = @()
try {
    $nics = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' }
    foreach ($nic in $nics) {
        $props = $nic.GetIPProperties()
        foreach ($ip in $props.UnicastAddresses) {
            if ($ip.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
                $addr = $ip.Address.ToString()
                if ($nic.Description -match "Tailscale" -or $nic.Name -match "Tailscale" -or $addr.StartsWith("100.")) {
                    $tailscaleIps += $addr
                } elseif ($nic.Description -match "Radmin" -or $nic.Name -match "Radmin" -or $addr.StartsWith("26.")) {
                    $radminIps += $addr
                } else {
                    $localIps += $addr
                }
            }
        }
    }
} catch {}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "            Shapez Multiplayer Server v1.1.0              " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

if ($radminIps.Count -gt 0) {
    Write-Host "Radmin VPN IP (игра с друзьями в сети Radmin):" -ForegroundColor Magenta
    foreach ($rip in $radminIps) {
        Write-Host "  -> ws://${rip}:7777" -ForegroundColor Yellow
    }
}

if ($tailscaleIps.Count -gt 0) {
    Write-Host "Tailscale IP (игра через интернет без открытия портов):" -ForegroundColor Magenta
    foreach ($tip in $tailscaleIps) {
        Write-Host "  -> ws://${tip}:7777" -ForegroundColor Yellow
    }
}

if ($localIps.Count -gt 0) {
    Write-Host "Локальная сеть (LAN / Домашний Wi-Fi):" -ForegroundColor White
    foreach ($lip in $localIps) {
        Write-Host "  -> ws://${lip}:7777" -ForegroundColor Gray
    }
}
Write-Host "Локальный тест (на этом же ПК): ws://127.0.0.1:7777" -ForegroundColor DarkGray
Write-Host "----------------------------------------------------------" -ForegroundColor DarkCyan

if (Test-Path $exePath) {
    Write-Host "Запуск сервера (автономный exe)..." -ForegroundColor Green
    & $exePath @args
} else {
    Write-Host "Автономный exe не найден, запускаем через Node.js..." -ForegroundColor Yellow
    Push-Location $projectDir
    try {
        node server.js @args
    } finally {
        Pop-Location
    }
}