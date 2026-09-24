$ErrorActionPreference = 'Stop'
# Load pure identity helpers only: no listener inspection and no process stop.
. (Join-Path $PSScriptRoot '..\companion\restart.ps1') -LibraryOnly
function Assert-HedaxTest {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw ('Failed: ' + $Name) }
}
function Synthetic-Process {
    param([string]$CommandLine, [string]$Executable = 'C:\Synthetic Runtime\node.exe')
    return [pscustomobject]@{ ExecutablePath = $Executable; CommandLine = $CommandLine }
}
$syntheticRoot = 'C:\Synthetic Project\HEDAX'
$syntheticGood = Synthetic-Process '"C:\Synthetic Runtime\node.exe" "C:\Synthetic Project\HEDAX\companion\server.cjs"'
Assert-HedaxTest (Test-HedaxProcessIdentity $syntheticGood $syntheticRoot) 'exact quoted executable and server argument'
Assert-HedaxTest (Test-HedaxProcessIdentity (Synthetic-Process 'C:\Runtime\node.exe C:\HEDAX\companion\server.cjs' 'C:\Runtime\node.exe') 'C:\HEDAX') 'unquoted arguments without spaces'
Assert-HedaxTest (Test-HedaxProcessIdentity (Synthetic-Process '"c:\synthetic runtime\NODE.EXE" "c:\synthetic project\hedax\companion\server.cjs"') $syntheticRoot) 'Windows case insensitive paths'

$syntheticBadCommands = @(
    '"C:\Synthetic Runtime\node.exe" "C:\Other Project\HEDAX\companion\server.cjs"',
    '"C:\Synthetic Runtime\node.exe" "C:\Synthetic Project\HEDAX\companion\server.cjs.backup"',
    '"C:\Synthetic Runtime\node.exe" "C:\Synthetic Project\HEDAX\companion\server.cjs"suffix',
    '"C:\Synthetic Runtime\node.exe" --eval "C:\Synthetic Project\HEDAX\companion\server.cjs"',
    '"C:\Synthetic Runtime\node.exe" "C:\Unrelated\worker.cjs" "C:\Synthetic Project\HEDAX\companion\server.cjs"',
    '"C:\Synthetic Runtime\node.exe" C:\Synthetic Project\HEDAX\companion\server.cjs',
    '"C:\Another Runtime\node.exe" "C:\Synthetic Project\HEDAX\companion\server.cjs"',
    '"C:\Synthetic Runtime\node.exe" companion\server.cjs'
)
foreach ($syntheticCommand in $syntheticBadCommands) {
    Assert-HedaxTest (-not (Test-HedaxProcessIdentity (Synthetic-Process $syntheticCommand) $syntheticRoot)) 'unrelated or ambiguously parsed command rejected'
}
Assert-HedaxTest (-not (Test-HedaxProcessIdentity (Synthetic-Process '"C:\Synthetic Runtime\cmd.exe" "C:\Synthetic Project\HEDAX\companion\server.cjs"' 'C:\Synthetic Runtime\cmd.exe') $syntheticRoot)) 'non-Node process rejected'
Assert-HedaxTest (-not (Test-HedaxProcessIdentity $syntheticGood 'relative-root')) 'relative project root rejected'
Assert-HedaxTest (-not (Test-HedaxProcessIdentity $null $syntheticRoot)) 'missing process rejected'

$syntheticLines = @(
    '  TCP    127.0.0.1:5173  0.0.0.0:0  LISTENING  54321',
    '  TCP    127.0.0.1:51730 0.0.0.0:0  LISTENING  11111',
    '  TCP    0.0.0.0:5173   0.0.0.0:0  LISTENING  22222',
    '  TCP    127.0.0.1:5173 127.0.0.1:8000 ESTABLISHED 33333',
    '  TCP    [::1]:5173     [::]:0     LISTENING  44444',
    '  UDP    127.0.0.1:5173 *:*        55555'
)
$syntheticIds = @(Get-HedaxListenerIds $syntheticLines 5173)
Assert-HedaxTest ($syntheticIds.Count -eq 1 -and $syntheticIds[0] -eq 54321) 'only exact loopback TCP listener selected'
$syntheticDuplicate = @(Get-HedaxListenerIds @($syntheticLines[0], $syntheticLines[0]) 5173)
Assert-HedaxTest ($syntheticDuplicate.Count -eq 1) 'duplicate listener lines resolve to one process'
$syntheticMultiple = @(Get-HedaxListenerIds @($syntheticLines[0], ' TCP 127.0.0.1:5173 0.0.0.0:0 LISTENING 65432') 5173)
Assert-HedaxTest ($syntheticMultiple.Count -eq 2) 'ambiguous listener owners remain visible for rejection'
Write-Output '17 synthetic restart identity checks passed; no process was inspected or stopped.'
