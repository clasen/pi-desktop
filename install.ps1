# Usage (PowerShell): iex (irm https://raw.githubusercontent.com/clasen/pi-desktop/master/install.ps1)
& {
    $ErrorActionPreference = 'Stop'
    $Repo = 'clasen/pi-desktop'
    $Releases = "https://github.com/$Repo/releases"
    $DownloadTimeoutSeconds = 600
    $Stage = $null

    function Get-Download([string] $Url, [string] $Path) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing -TimeoutSec $DownloadTimeoutSeconds
        } catch {
            throw "Download failed: $Url. Check your connection and available disk space. $($_.Exception.Message)"
        }
    }

    try {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            throw 'Use install.sh on macOS or Linux.'
        }
        $Architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        if ($Architecture -ne 'AMD64') {
            throw "No prebuilt Windows installer for $Architecture. See $Releases."
        }
        # GitHub and pi.dev require TLS 1.2 on Windows PowerShell 5.1.
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $Stage = Join-Path ([IO.Path]::GetTempPath()) ("pi-desktop-install-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $Stage | Out-Null
        Write-Host 'Pi Desktop installer: Windows x64. Close Pi Desktop before updating.'
        $Metadata = Join-Path $Stage 'releases.json'
        Get-Download "https://api.github.com/repos/$Repo/releases?per_page=10" $Metadata
        $ReleaseList = Get-Content -Raw -LiteralPath $Metadata | ConvertFrom-Json
        $Asset = $ReleaseList | Where-Object { -not $_.draft } | ForEach-Object { $_.assets } |
            Where-Object { $_.name -cmatch '^Pi-Desktop-[A-Za-z0-9.+_-]+-win-x64-setup\.exe$' } |
            Select-Object -First 1
        if (-not $Asset) {
            throw "No published Windows x64 installer found. Publish a version tag in $Repo and wait for the Build workflow: $Releases."
        }
        $Url = [string] $Asset.browser_download_url
        $AllowedUrl = '^https://github\.com/' + [regex]::Escape($Repo) + '/releases/download/[A-Za-z0-9._-]+/' + [regex]::Escape($Asset.name) + '$'
        if ($Url -cnotmatch $AllowedUrl) { throw 'Unexpected installer URL in release metadata.' }
        $Checksum = Join-Path $Stage 'checksum'
        Get-Download "$Url.sha256" $Checksum
        $Expected = ((Get-Content -Raw -LiteralPath $Checksum).Trim() -split '\s+')[0]
        if ($Expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid SHA-256 checksum. Nothing was installed.' }
        $Installer = Join-Path $Stage $Asset.name
        Get-Download $Url $Installer
        if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash -ne $Expected) {
            throw 'SHA-256 mismatch. Nothing was installed; download again or report the release.'
        }
        Write-Host 'Opening the installer. Alpha builds are unsigned; Windows may show a security warning.'
        $Process = Start-Process -FilePath $Installer -Wait -PassThru
        if ($Process.ExitCode -ne 0) {
            throw "The installer exited with code $($Process.ExitCode). Installation may have been cancelled or blocked."
        }
        Write-Host 'Pi Desktop installed. Open it from the Start menu.'
        if (-not (Get-Command pi -ErrorAction SilentlyContinue) -and -not (Get-Command omp -ErrorAction SilentlyContinue)) {
            Write-Host 'Pi or OMP is required to run an agent. Neither was found on PATH.'
            $Answer = Read-Host 'Download and run the official Pi installer from https://pi.dev/install.ps1? [y/N]'
            if ($Answer -eq 'y') {
                $PiInstaller = Join-Path $Stage 'install-pi.ps1'
                Get-Download 'https://pi.dev/install.ps1' $PiInstaller
                # Use a child so an exit in the official installer cannot skip cleanup.
                & powershell.exe -NoProfile -File $PiInstaller
                if ($LASTEXITCODE -ne 0) {
                    throw 'Pi installation failed. Pi Desktop is installed; retry Pi installation separately.'
                }
                Write-Host 'Pi installer finished. Open a new terminal so PATH changes take effect.'
            } else {
                Write-Host 'Skipped Pi installation. Install Pi/OMP later or select an existing executable in Settings > Agent Configuration.'
            }
        }
    } catch {
        throw "Pi Desktop: $($_.Exception.Message)"
    } finally {
        if ($Stage -and (Test-Path -LiteralPath $Stage)) {
            Remove-Item -LiteralPath $Stage -Recurse -Force
        }
    }
}
