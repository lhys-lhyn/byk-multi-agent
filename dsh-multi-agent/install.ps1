# BYK Interactive Multi-Agent System DSH Plugin Installation Script

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "BYK Interactive Multi-Agent System DSH Plugin Installer" -ForegroundColor Cyan
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

# Check if headless profile exists
$headlessProfile = "$dshHome\profiles\headless"
if (-not (Test-Path $headlessProfile)) {
    Write-Host "headless profile not found, creating..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $headlessProfile -Force | Out-Null
    
    # Create package.json
    $packageJson = @{
        name = "dsh-profile-headless"
        private = $true
        dependencies = @{}
        dsh = @{
            profile = @{
                bundles = @("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless")
            }
        }
    } | ConvertTo-Json -Depth 10
    
    Set-Content -Path "$headlessProfile\package.json" -Value $packageJson -Encoding UTF8
    
    # Create cordis.patch.yml
    Set-Content -Path "$headlessProfile\cordis.patch.yml" -Value "[]" -Encoding UTF8
    
    # Create cordis.yml
    $cordisYml = @"
# dsh profile root - an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
"@
    Set-Content -Path "$headlessProfile\cordis.yml" -Value $cordisYml -Encoding UTF8
    
    # Create pnpm-workspace.yaml
    Set-Content -Path "$headlessProfile\pnpm-workspace.yaml" -Value "" -Encoding UTF8
    
    Write-Host "headless profile created" -ForegroundColor Green
}

# Create plugin directory
$pluginDir = "$headlessProfile\node_modules\@byk\dsh-multi-agent"
Write-Host "Creating plugin directory: $pluginDir" -ForegroundColor Yellow
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null

# Copy plugin files
Write-Host "Copying plugin files..." -ForegroundColor Yellow
$sourceDir = "C:\Projects\byk\dsh-multi-agent"

# Copy package.json
Copy-Item -Path "$sourceDir\package.json" -Destination $pluginDir -Force

# Copy cordis.patch.yml
Copy-Item -Path "$sourceDir\cordis.patch.yml" -Destination $pluginDir -Force

# Copy lib directory
Copy-Item -Path "$sourceDir\lib" -Destination $pluginDir -Recurse -Force

# Copy README
Copy-Item -Path "$sourceDir\README.md" -Destination $pluginDir -Force

# Copy architecture document
Copy-Item -Path "C:\Projects\byk\MULTI-AGENT-ARCHITECTURE.md" -Destination $pluginDir -Force

Write-Host "Plugin files copied" -ForegroundColor Green

# Update headless profile package.json
$profilePackageJson = Get-Content "$headlessProfile\package.json" | ConvertFrom-Json
if (-not $profilePackageJson.dependencies) {
    $profilePackageJson | Add-Member -NotePropertyName "dependencies" -NotePropertyValue @{}
}
$profilePackageJson.dependencies | Add-Member -NotePropertyName "@byk/dsh-multi-agent" -NotePropertyValue "file:./node_modules/@byk/dsh-multi-agent" -Force
$profilePackageJson | ConvertTo-Json -Depth 10 | Set-Content -Path "$headlessProfile\package.json" -Encoding UTF8

Write-Host "Updated headless profile configuration" -ForegroundColor Green

# Update cordis.patch.yml
$cordisPatch = @"
# BYK Interactive Multi-Agent System DSH Plugin Configuration

- id: system-prompt
  config:
    personaSuffix: Your working directory is {{cwd}}.
    personaPrefix: >-
      你是 BYK 交互式多智能体协作系统的主对话。你的职责是：
      1. 接收用户的问题、提示词、文件等
      2. 将输入分发给不同的助手
      3. 监控任务进度，实时向用户汇报
      4. 任务完成后，总结各助手的结果发给用户

      你不是一个独立的助手，你是一个协调者。你负责与用户对话，但不直接处理任务。
      所有具体任务都由七个专门的助手处理：
      - 任务助手：识别任务，拆解子任务，指派角色
      - 代码助手：代码审查、执行命令、部署等
      - 视觉助手：识别图片、视频内容
      - 文件助手：提取文件内容
      - 语音助手：提取语音内容
      - 科研助手：处理科研问题
      - 搜索助手：从网上搜索信息

- id: tools
  config:
    mode: !!js process.env.DSH_TOOLS_MODE

- insert:
    # BYK Interactive Multi-Agent Orchestrator
    - id: interactive-multi-agent-orchestrator
      name: '@byk/dsh-multi-agent'
      inject: [agentDefaultModel, agents, sessions, headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task

- id: hmr
  disabled: true
"@

Set-Content -Path "$headlessProfile\cordis.patch.yml" -Value $cordisPatch -Encoding UTF8

Write-Host "Updated plugin configuration" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Installation Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Now you can test the interactive multi-agent system:" -ForegroundColor Yellow
Write-Host '  dsh --profile headless "Please create a Python script to calculate Fibonacci sequence"' -ForegroundColor White
Write-Host ""
Write-Host "The system will:" -ForegroundColor Yellow
Write-Host "  1. Receive your query" -ForegroundColor White
Write-Host "  2. Task assistant will analyze and create a plan" -ForegroundColor White
Write-Host "  3. Show you the plan for confirmation" -ForegroundColor White
Write-Host "  4. Execute the plan after your confirmation" -ForegroundColor White
Write-Host "  5. Monitor progress and report in real-time" -ForegroundColor White
Write-Host "  6. Summarize results when complete" -ForegroundColor White
Write-Host ""
Write-Host "Or start the BYK service to use the Web interface:" -ForegroundColor Yellow
Write-Host "  cd C:\Projects\byk" -ForegroundColor White
Write-Host '  .\.venv\Scripts\python.exe -m byk --host 127.0.0.1 --port 8760' -ForegroundColor White
Write-Host ""
Write-Host "Then visit http://127.0.0.1:8760" -ForegroundColor Cyan