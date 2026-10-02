<#
  Cherysis 网页版：开机自启（登录时）的安装 / 卸载 / 查看。

  用法（双击根目录的「设置开机自启.cmd」走的就是第一条）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 install
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 remove
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 status
    （加 -DryRun 只看会发生什么，不真建 —— 它不碰任务计划程序，所以被策略挡住时也能看）

  为什么用「登录时」触发器，而不是「不管用户是否登录」：
  数据在共享盘 z: 上（= \\LIAN\DeskTop\…），而**映射盘只在有人登录的会话里存在**。
  用"不管是否登录"会在会话 0 里跑，那时 z: 不存在 —— 服务读不到数据目录，
  更糟的是它可能在一个空路径上"成功"建出一个空库。启动器的体检会拦住这一种，
  但更好的做法是根本不让它发生：登录时起 = 与你平时手动双击的环境完全一致。
  代价：**没人登录就不会起**。要"没人登录也跑"，得把配置里的 z: 换成 UNC 路径
  （\\LIAN\DeskTop\…）并把触发器改成开机时，那时共享盘凭据又得单独解决 ——
  见 docs/网页版-上手与自测.md 第九节。

  这个脚本用 Register-ScheduledTask（结构化参数），不拼 schtasks 的命令行 ——
  那种嵌套引号在路径带空格时非常容易出错。

  注：本文件必须带 UTF-8 BOM。Windows PowerShell 5.1（双击 .cmd 时用的那个）
  读无 BOM 的 UTF-8 会按 ANSI 解，中文全成乱码并报 Unexpected token。
  改完这个文件跑一下 node scripts/fix-ps1-bom.cjs。
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'remove', 'status')]
  [string]$Action = 'status',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$taskName = 'CherysisWebServer'
$configFile = Join-Path $root 'cherysis-server.config.json'
$launcher = Join-Path $root 'scripts\serve-web.cjs'
$entry = Join-Path $root 'out\server\index.js'

function Get-NodeExe {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

function Show-Status {
  $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $t) {
    Write-Host "未设置开机自启（没有名为 $taskName 的计划任务）。" -ForegroundColor Yellow
    Write-Host "要设置：双击根目录的「设置开机自启.cmd」"
    return
  }
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  $act = ($t.Actions | Select-Object -First 1)
  Write-Host "已设置开机自启：" -ForegroundColor Green
  Write-Host ("  任务名   ：{0}" -f $taskName)
  Write-Host ("  状态     ：{0}" -f $t.State)
  Write-Host ("  程序     ：{0}" -f $act.Execute)
  Write-Host ("  参数     ：{0}" -f $act.Arguments)
  Write-Host ("  上次运行 ：{0}（结果码 {1}）" -f $info.LastRunTime, $info.LastTaskResult)
  Write-Host ""
  Write-Host "下次登录 Windows 时会自动把服务起起来（会看到一个控制台窗口，关掉它=停服务）。"
  Write-Host "现在就想起：双击根目录的「启动网页版.cmd」。"
}

function Do-Install {
  if (-not (Test-Path $configFile)) {
    Write-Host "[错误] 没找到配置文件：$configFile" -ForegroundColor Red
    Write-Host "       先把 cherysis-server.config.example.json 复制成 cherysis-server.config.json 并改好路径。"
    exit 1
  }
  if (-not (Test-Path $entry)) {
    Write-Host "[错误] 还没编译过（找不到 out\server\index.js）：先在项目目录里跑 pnpm run compile" -ForegroundColor Red
    exit 1
  }
  $node = Get-NodeExe
  if (-not $node) {
    Write-Host "[错误] 找不到 node.exe。装过 Node 的话把它的目录加进 PATH。" -ForegroundColor Red
    exit 1
  }
  $argLine = '"{0}" --config="{1}"' -f $launcher, $configFile

  if ($DryRun) {
    Write-Host "[DryRun] 会创建这样的任务（不碰任务计划程序）：" -ForegroundColor Cyan
    Write-Host ("  任务名  ：{0}" -f $taskName)
    Write-Host ("  程序    ：{0}" -f $node)
    Write-Host ("  参数    ：{0}" -f $argLine)
    Write-Host ("  起始于  ：{0}" -f $root)
    Write-Host  "  触发器  ：登录时（AtLogOn，当前用户）"
    Write-Host  "  设置    ：不限时 / 崩溃自动重启 3 次（每分钟）/ 错过时间也补跑"
    return
  }

  try {
    $action = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    # ExecutionTimeLimit=0 = 不限时（默认只给 3 天，长跑的服务会被莫名杀掉）
    # RestartCount/RestartInterval：崩了自己再起来
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -DontStopOnIdleEnd -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $desc = 'Cherysis 网页版服务（登录时启动；关掉那个控制台窗口 = 停服务）'
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
      -Settings $settings -Description $desc -Force | Out-Null
  }
  catch {
    Write-Host ""
    Write-Host ("[错误] 建计划任务失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host ""
    Write-Host "两条出路（按顺序试）：" -ForegroundColor Yellow
    Write-Host "  1) 用管理员身份：开始菜单搜 cmd → 右键「以管理员身份运行」→ 进项目目录再执行一次"
    Write-Host "     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 install"
    Write-Host "     （有些公司的安全策略只允许管理员注册计划任务）"
    Write-Host "  2) 手动建（五分钟）：开始菜单搜「任务计划程序」→ 创建任务，照下面填："
    Write-Host ("       常规  ：名称 {0}；选「只在用户登录时运行」" -f $taskName)
    Write-Host  "       触发器：新建 → 开始任务选「登录时」→ 确定"
    Write-Host ("       操作  ：新建 → 程序或脚本：{0}" -f $node)
    Write-Host ("              添加参数：{0}" -f $argLine)
    Write-Host ("              起始于  ：{0}" -f $root)
    Write-Host  "       设置  ：勾「如果任务失败，按以下频率重新启动」；把「如果任务运行超过以下时间则停止」取消勾选"
    Write-Host ""
    exit 1
  }

  Write-Host "✅ 已设置开机自启（登录时）" -ForegroundColor Green
  Write-Host ("  任务名：{0}" -f $taskName)
  Write-Host ("  配置  ：{0}" -f $configFile)
  Write-Host ""
  Write-Host "说明："
  Write-Host "  · 下次登录 Windows 时自动起（会看到一个控制台窗口，关掉它=停服务）"
  Write-Host "  · 现在就想起：双击根目录的「启动网页版.cmd」"
  Write-Host "  · 想取消：双击「取消开机自启.cmd」"
  Write-Host "  · 为什么是「登录时」：数据在共享盘 z: 上，映射盘只在登录会话里存在"
}

function Do-Remove {
  $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $t) {
    Write-Host "本来就没有这个任务（$taskName），不用取消。" -ForegroundColor Yellow
    return
  }
  if ($DryRun) {
    Write-Host "[DryRun] 会删除计划任务：$taskName" -ForegroundColor Cyan
    return
  }
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  catch {
    Write-Host ("[错误] 删除失败：{0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "用管理员身份重试，或在「任务计划程序」里手动删掉那个任务。"
    exit 1
  }
  Write-Host "✅ 已取消开机自启（计划任务 $taskName 已删除）" -ForegroundColor Green
  Write-Host "（已经在跑的服务不受影响：要停就关掉那个控制台窗口）"
}

switch ($Action) {
  'install' { Do-Install }
  'remove' { Do-Remove }
  default { Show-Status }
}
