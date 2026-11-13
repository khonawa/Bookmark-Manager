param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [string]$ConnectorExe = (Join-Path $PSScriptRoot 'target\debug\bookmark-desk-connector.exe'),
    [ValidateSet('Chrome', 'Edge', 'Both')][string]$Browser = 'Both',
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$HostName = 'com.bookmarkdesk.connector'
$RegistryPaths = @()
if ($Browser -in @('Chrome', 'Both')) { $RegistryPaths += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName" }
if ($Browser -in @('Edge', 'Both')) { $RegistryPaths += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName" }
$Config = Get-Content -Raw (Join-Path $PSScriptRoot 'tauri.conf.json') | ConvertFrom-Json
$AppDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $Config.identifier
$ManifestPath = Join-Path $AppDirectory "$HostName.json"
if ($Uninstall) {
    foreach ($RegistryPath in $RegistryPaths) { Remove-Item -LiteralPath $RegistryPath -Recurse -Force -ErrorAction SilentlyContinue }
    # Keep the shared manifest if the other browser is still registered.
    $Remaining = @("HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName", "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName") | Where-Object { Test-Path -LiteralPath $_ }
    if (-not $Remaining) { Remove-Item -LiteralPath $ManifestPath -Force -ErrorAction SilentlyContinue }
    Write-Output "$Browser registration removed. Disable extension pairing in Bookmark Desk to revoke access."
    exit
}
$Exe = (Resolve-Path -LiteralPath $ConnectorExe).Path
if ([IO.Path]::GetExtension($Exe) -ne '.exe') { throw 'ConnectorExe must be the actual connector EXE, not a wrapper.' }
New-Item -ItemType Directory -Path $AppDirectory -Force | Out-Null
$Manifest = [ordered]@{
    name = $HostName
    description = 'Bookmark Desk native messaging connector'
    path = $Exe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Json = $Manifest | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($ManifestPath, $Json, (New-Object Text.UTF8Encoding($false)))
foreach ($RegistryPath in $RegistryPaths) {
    New-Item -Path $RegistryPath -Force | Out-Null
    Set-Item -LiteralPath $RegistryPath -Value $ManifestPath
}
Write-Output "Registered $HostName for chrome-extension://$ExtensionId/"
Write-Output "Descriptor: $(Join-Path $AppDirectory 'native-connector.json')"
Write-Output 'Start Bookmark Desk and explicitly pair the same extension ID. Registration alone does not enable access.'
