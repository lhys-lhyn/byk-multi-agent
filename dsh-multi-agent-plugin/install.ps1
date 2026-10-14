# BYK Multi-Agent System DSH Plugin Installation Script (Web Profile)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "BYK Multi-Agent System DSH Plugin Installer (Web Profile)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if DSH is installed
$dshHome = "$env:APPDATA\com.yeagoo.dsh-desktop\harness"
if (-not (Test-Path $dshHome)) {
    Write-Host "Error: DSH not installed or DSH Home directory not found" -ForegroundColor Red
    Write-Host "Please install DeepSeek Harness Desktop first" -ForegroundColor Yellow
    exit 1
}

Write-Host "Found DSH Home directory: $dshHome" -ForegroundColor Green

# Check if web profile exists
$webProfile = "$dshHome\profiles\web"
if (-not (Test-Path $webProfile)) {
    Write-Host "Error: web profile not found" -ForegroundColor Red
    Write-Host "Please install DSH Desktop properly" -ForegroundColor Yellow
    exit 1
}

Write-Host "Found web profile: $webProfile" -ForegroundColor Green

# Create plugin directory
$pluginDir = "$webProfile\node_modules\@byk\dsh-multi-agent-plugin"
Write-Host "Creating plugin directory: $pluginDir" -ForegroundColor Yellow
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null

# Copy plugin files
Write-Host "Copying plugin files..." -ForegroundColor Yellow
$sourceDir = "C:\Projects\byk\dsh-multi-agent-plugin"

# Copy package.json
Copy-Item -Path "$sourceDir\package.json" -Destination $pluginDir -Force

# Copy cordis.patch.yml
Copy-Item -Path "$sourceDir\cordis.patch.yml" -Destination $pluginDir -Force

# Copy lib directory
Copy-Item -Path "$sourceDir\lib" -Destination $pluginDir -Recurse -Force

# Update web profile package.json
$profilePackageJson = Get-Content "$webProfile\package.json" | ConvertFrom-Json
if (-not $profilePackageJson.dependencies) {
    $profilePackageJson | Add-Member -NotePropertyName "dependencies" -NotePropertyValue @{}
}
$profilePackageJson.dependencies | Add-Member -NotePropertyName "@byk/dsh-multi-agent-plugin" -NotePropertyValue "file:./node_modules/@byk/dsh-multi-agent-plugin" -Force
$profilePackageJson | ConvertTo-Json -Depth 10 | Set-Content -Path "$webProfile\package.json" -Encoding UTF8

Write-Host "Updated web profile configuration" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Installation Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "The multi-agent system is now installed in DSH Web profile." -ForegroundColor Yellow
Write-Host "When you use DSH Desktop, it will automatically:" -ForegroundColor White
Write-Host "  1. Receive your query" -ForegroundColor White
Write-Host "  2. Analyze which assistants are needed" -ForegroundColor White
Write-Host "  3. Show you the execution plan" -ForegroundColor White
Write-Host "  4. Execute after your confirmation" -ForegroundColor White
Write-Host "  5. Monitor progress in real-time" -ForegroundColor White
Write-Host "  6. Summarize results when complete" -ForegroundColor White
Write-Host ""
Write-Host "To test, restart DSH Desktop and start a new conversation." -ForegroundColor Yellow
Write-Host "The multi-agent system will automatically activate." -ForegroundColor White