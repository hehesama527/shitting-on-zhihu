$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Get-MysqlRootPassword {
    if ($env:MYSQL_ROOT_PASSWORD) {
        return $env:MYSQL_ROOT_PASSWORD
    }

    $envFile = Join-Path $PSScriptRoot ".env"
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match '^MYSQL_URL=mysql://[^:]+:([^@]+)@') {
                return $Matches[1]
            }
        }
    }

    Write-Host "  -> Set MYSQL_ROOT_PASSWORD or MYSQL_URL in .env before starting MySQL." -ForegroundColor Red
    exit 1
}

$mysqlRootPassword = Get-MysqlRootPassword

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Claw services startup" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/4] Checking MySQL Docker container..." -ForegroundColor Yellow

$mysqlContainer = docker ps -a --filter "name=mysql-zhihu" --format "{{.ID}}" 2>$null

if ($mysqlContainer) {
    $containerStatus = docker inspect $mysqlContainer --format '{{.State.Status}}' 2>$null
    if ($containerStatus -ne "running") {
        Write-Host "  -> Starting MySQL container..." -ForegroundColor Yellow
        docker start $mysqlContainer | Out-Null
        Write-Host "  -> MySQL container started" -ForegroundColor Green
    } else {
        Write-Host "  -> MySQL container is already running" -ForegroundColor Green
    }
} else {
    Write-Host "  -> MySQL container not found, creating one..." -ForegroundColor Yellow
    docker run -d `
        --name mysql-zhihu `
        -p 6306:3306 `
        -e MYSQL_ROOT_PASSWORD=$mysqlRootPassword `
        -e MYSQL_DATABASE=zhihu_mvp `
        -v mysql-zhihu-data:/var/lib/mysql `
        mysql:8.0 | Out-Null

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  -> Docker is unavailable or MySQL creation failed. Check Docker Desktop first." -ForegroundColor Red
        exit 1
    }

    Write-Host "  -> MySQL container created and started" -ForegroundColor Green
}

Write-Host ""
Write-Host "[2/4] Waiting for MySQL..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

$mysqlReady = $false
for ($i = 1; $i -le 10; $i++) {
    try {
        mysql -h 127.0.0.1 -P 6306 -u root -p"$mysqlRootPassword" -e "SELECT 1" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $mysqlReady = $true
            break
        }
    } catch {
    }

    Write-Host "  -> Trying MySQL connection... ($i/10)" -ForegroundColor Gray
    Start-Sleep -Seconds 2
}

if (-not $mysqlReady) {
    Write-Host "  -> MySQL connection failed. Check local DB config." -ForegroundColor Red
    exit 1
}

Write-Host "  -> MySQL is ready" -ForegroundColor Green

Write-Host ""
Write-Host "[3/4] Starting backend services..." -ForegroundColor Yellow

$backendServices = @(
    @{ Workspace = "@zhihu-mvp/api"; Label = "Zhihu API"; Url = "http://localhost:8787" },
    @{ Workspace = "@zhihu-mvp/worker"; Label = "Zhihu Worker"; Url = "" },
    @{ Workspace = "@zhihu-mvp/hotspot-api"; Label = "Hotspot API"; Url = "http://localhost:8789" },
    @{ Workspace = "@zhihu-mvp/control-api"; Label = "Control API"; Url = "http://localhost:8790" },
    @{ Workspace = "@zhihu-mvp/x-api"; Label = "X Main API"; Url = "http://localhost:8788" },
    @{ Workspace = "@zhihu-mvp/x-worker"; Label = "X Main Worker"; Url = "" },
    @{ Workspace = "@zhihu-mvp/x-traditional-api"; Label = "X Traditional API"; Url = "http://localhost:8791" },
    @{ Workspace = "@zhihu-mvp/x-traditional-worker"; Label = "X Traditional Worker"; Url = "" },
    @{ Workspace = "@zhihu-mvp/ops-agent"; Label = "Ops Agent"; Url = "" }
)

foreach ($service in $backendServices) {
    Write-Host "  -> Starting $($service.Label)..." -ForegroundColor Gray
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot'; npm run dev -w $($service.Workspace)"
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "[4/4] Starting Web..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$PSScriptRoot'; npm run dev -w @zhihu-mvp/web"

Write-Host ""
Write-Host "=====================================" -ForegroundColor Green
Write-Host "Services started" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Green
Write-Host ""
Write-Host "URLs:" -ForegroundColor Cyan
Write-Host "  - Web: http://localhost:3000" -ForegroundColor White
Write-Host "  - Zhihu API: http://localhost:8787" -ForegroundColor White
Write-Host "  - Hotspot API: http://localhost:8789" -ForegroundColor White
Write-Host "  - Control API: http://localhost:8790" -ForegroundColor White
Write-Host "  - X Main API: http://localhost:8788" -ForegroundColor White
Write-Host "  - X Traditional API: http://localhost:8791" -ForegroundColor White
Write-Host ""
Write-Host "Health checks:" -ForegroundColor Cyan
Write-Host "  - http://localhost:8787/health" -ForegroundColor White
Write-Host "  - http://localhost:8789/health" -ForegroundColor White
Write-Host "  - http://localhost:8790/health" -ForegroundColor White
Write-Host "  - http://localhost:8788/health" -ForegroundColor White
Write-Host "  - http://localhost:8791/health" -ForegroundColor White
