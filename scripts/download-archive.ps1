# Share verified downloads between the editor and debugger setup scripts.
function Get-NidoArchiveSha256 {
    param([string] $Path)
    # Get-FileHash may be unavailable in CI's nested Windows PowerShell process.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}

function Get-NidoVerifiedArchive {
    param([string] $Uri, [string] $Path, [string] $ExpectedHash)
    if (Test-Path -LiteralPath $Path) {
        if ((Get-NidoArchiveSha256 $Path) -eq $ExpectedHash) { return }
        Remove-Item -LiteralPath $Path -Force
    }
    # An interrupted request must never leave a partial archive at the cache path.
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $temporary | Out-Null
        if ((Get-NidoArchiveSha256 $temporary) -ne $ExpectedHash) {
            throw "Archive checksum mismatch: $Path"
        }
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}
