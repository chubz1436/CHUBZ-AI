[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('validate-config','migrate','start','wait-ready','health','stop','inspect-runtime','clear-stale-pids','inspect-emergency-stop','verify-package','diagnostics','upgrade-plan','retention-preview','current-version')]
  [string]$Command,
  [string]$ConfigPath,
  [string]$ArtifactId
)
$ErrorActionPreference='Stop'
$packageRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$cliPath=Join-Path $packageRoot 'app\runtime-cli.mjs'
if(-not (Test-Path -LiteralPath $cliPath -PathType Leaf)){throw 'The verified runtime command entry is unavailable.'}
$node=(Get-Command node.exe -ErrorAction Stop).Source
$arguments=@($cliPath,$Command)
if($Command -ne 'verify-package' -and $Command -ne 'current-version'){
  if([string]::IsNullOrWhiteSpace($ConfigPath)){throw 'An explicit configuration path is required.'}
  $resolvedConfig=(Resolve-Path -LiteralPath $ConfigPath).Path
  $arguments+=@('--config',$resolvedConfig)
}
if(-not [string]::IsNullOrWhiteSpace($ArtifactId)){$arguments+=@('--artifact-id',$ArtifactId)}
& $node @arguments
if($LASTEXITCODE -ne 0){throw 'The bounded runtime command failed safely.'}
