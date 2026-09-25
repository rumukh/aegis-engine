[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RawModel,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$BlenderExecutable = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe',
    [string]$MotionSource = (Join-Path $PSScriptRoot '..\..\generated\responder.glb')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $BlenderExecutable -PathType Leaf)) { throw 'Configured Blender executable is missing; no fallback is permitted.' }
$version = & $BlenderExecutable --version
if ($LASTEXITCODE -ne 0 -or $version[0] -ne 'Blender 5.2.2 LTS') { throw 'This character recipe requires measured Blender 5.2.2 LTS.' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Use a fresh local cooking revision directory.' }
$source = (Resolve-Path -LiteralPath $RawModel).Path
$motion = (Resolve-Path -LiteralPath $MotionSource).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
& $BlenderExecutable --background --factory-startup --python-exit-code 1 --python "$PSScriptRoot\cook.py" -- `
    --input $source --motion $motion --out $output 2>&1 | Tee-Object -FilePath "$output.log"
if ($LASTEXITCODE -ne 0) { throw "Character cook failed. Inspect $output\cook.json and $output.log; no automatic retry." }
