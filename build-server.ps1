$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $projectDir
try {
    npm install
    npm test
    npm run check
    & "$projectDir\node_modules\.bin\pkg.cmd" server.js --targets node22-win-x64 --output "$projectDir\shapez-multiplayer-server.exe"
    Write-Host "Built: $projectDir\shapez-multiplayer-server.exe"
} finally {
    Pop-Location
}
