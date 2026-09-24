param([switch]$LibraryOnly)
$ErrorActionPreference = 'Stop'

# A matching HTTP response alone cannot authorize stopping a process. Both the
# exact listener and the executable/script identity must match this installation.
function Test-HedaxProcessIdentity {
    param($Candidate, [string]$ProjectRoot)
    if ($null -eq $Candidate -or [string]::IsNullOrWhiteSpace($Candidate.ExecutablePath) -or [string]::IsNullOrWhiteSpace($Candidate.CommandLine)) { return $false }
    try {
        if (-not [IO.Path]::IsPathRooted($ProjectRoot) -or -not [IO.Path]::IsPathRooted($Candidate.ExecutablePath)) { return $false }
        $hedaxExecutable = [IO.Path]::GetFullPath($Candidate.ExecutablePath)
        if ([IO.Path]::GetFileName($hedaxExecutable) -ine 'node.exe') { return $false }
        $hedaxScript = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'companion\server.cjs'))
        $hedaxExePattern = '"' + [regex]::Escape($hedaxExecutable) + '"'
        if ($hedaxExecutable -notmatch '\s') { $hedaxExePattern += '|' + [regex]::Escape($hedaxExecutable) }
        $hedaxScriptPattern = '"' + [regex]::Escape($hedaxScript) + '"'
        if ($hedaxScript -notmatch '\s') { $hedaxScriptPattern += '|' + [regex]::Escape($hedaxScript) }
        # Require server.cjs as Node's first argument, not text inside --eval or
        # an unrelated program argument. Quotes and argument boundaries are exact.
        $hedaxPattern = '^\s*(?:' + $hedaxExePattern + ')\s+(?:' + $hedaxScriptPattern + ')(?=\s|$)'
        return [regex]::IsMatch($Candidate.CommandLine, $hedaxPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    } catch { return $false }
}

function Get-HedaxListenerIds {
    param([string[]]$Lines, [int]$Port)
    $hedaxListenerPattern = '^\s*TCP\s+127\.0\.0\.1:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$'
    $hedaxIds = foreach ($hedaxLine in $Lines) {
        if ($hedaxLine -match $hedaxListenerPattern) { [int]$Matches[1] }
    }
    return @($hedaxIds | Sort-Object -Unique)
}

if ($LibraryOnly) { return }
try {
    $hedaxRoot = $env:HEDAX_RESTART_ROOT
    $hedaxPort = 0
    if ([string]::IsNullOrWhiteSpace($hedaxRoot) -or -not [IO.Path]::IsPathRooted($hedaxRoot) -or -not [int]::TryParse($env:HEDAX_RESTART_PORT, [ref]$hedaxPort) -or $hedaxPort -lt 1 -or $hedaxPort -gt 65535) { throw 'Invalid restart request.' }
    $hedaxNetstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
    $hedaxNetstatLines = & $hedaxNetstat -ano -p TCP
    if ($LASTEXITCODE -ne 0) { throw 'Listener inspection failed.' }
    $hedaxListenerIds = @(Get-HedaxListenerIds -Lines $hedaxNetstatLines -Port $hedaxPort)
    if ($hedaxListenerIds.Count -ne 1 -or $hedaxListenerIds[0] -le 0) { throw 'Listener identity is not unique.' }
    $hedaxProcessId = $hedaxListenerIds[0]
    $hedaxCandidate = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $hedaxProcessId)
    if (-not (Test-HedaxProcessIdentity -Candidate $hedaxCandidate -ProjectRoot $hedaxRoot)) { throw 'Process identity did not match.' }
    Stop-Process -Id $hedaxProcessId -Confirm:$false -ErrorAction Stop
    exit 0
} catch {
    # Do not echo command lines, executable locations, account names, or tokens.
    [Console]::Error.WriteLine('HEDAX restart refused: the old companion could not be verified and closed.')
    exit 1
}
