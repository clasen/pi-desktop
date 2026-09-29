const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const payload = Buffer.from('installer payload\n')
const digest = createHash('sha256').update(payload).digest('hex')
const windows = process.platform === 'win32'

function fixture(t, suffix) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-installer-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = path.join(dir, 'home with spaces')
  const bin = path.join(dir, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(path.join(dir, 'temp'))
  const name = `Pi-Desktop-1.2.3-alpha-${suffix}`
  const url = `https://github.com/clasen/pi-desktop/releases/download/v1.2.3-alpha/${name}`
  const asset = { name, browser_download_url: url }
  writeFileSync(path.join(dir, 'releases.json'), JSON.stringify([
    { draft: false, prerelease: true, assets: [] },
    { draft: false, prerelease: true, assets: [asset] },
  ], null, 2))
  writeFileSync(path.join(dir, 'payload'), payload)
  writeFileSync(path.join(dir, 'checksum'), `${digest}  ${name}\n`)
  return { dir, home, bin, name, url }
}

function mock(bin, name, source) {
  const file = path.join(bin, name)
  writeFileSync(`${file}.js`, source)
  writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${file}.js' "$@"\n`, { mode: 0o755 })
}

function shellFixture(t, platform = 'Linux', arch = 'x86_64') {
  const f = fixture(t, platform === 'Darwin' ? (arch === 'arm64' ? 'mac-arm64.zip' : 'mac-x64.zip') : 'linux-x86_64.AppImage')
  mock(f.bin, 'uname', `console.log(process.argv[2] === '-s' ? process.env.TEST_OS : process.env.TEST_ARCH)`)
  mock(f.bin, 'sysctl', `console.log(process.env.TEST_ROSETTA || '0')`)
  mock(f.bin, 'pi', '')
  mock(f.bin, 'curl', `
    const fs = require('node:fs'), path = require('node:path')
    const args = process.argv.slice(2), dir = process.env.TEST_DIR
    const out = args[args.indexOf('-o') + 1], url = args[args.indexOf('-o') - 1]
    fs.appendFileSync(path.join(dir, 'requests'), url + '\\n')
    const kind = url.includes('/releases?') ? 'releases.json' : url.endsWith('.sha256') ? 'checksum' : 'payload'
    if (process.env.TEST_FAIL === kind) process.exit(22)
    fs.copyFileSync(path.join(dir, kind), out)
  `)
  for (const command of ['sha256sum', 'shasum']) {
    mock(f.bin, command, `
      const fs = require('node:fs'), crypto = require('node:crypto')
      const file = process.argv[process.argv.length - 1]
      console.log(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + file)
    `)
  }
  mock(f.bin, 'ditto', `
    const fs = require('node:fs'), path = require('node:path')
    const dest = process.argv[process.argv.length - 1]
    if (process.env.TEST_FAIL === 'unpack') process.exit(1)
    if (process.env.TEST_FAIL !== 'bundle') {
      fs.mkdirSync(path.join(dest, 'Pi Desktop.app', 'Contents'), { recursive: true })
      fs.writeFileSync(path.join(dest, 'Pi Desktop.app', 'Contents', 'new'), 'new app')
    }
  `)
  mock(f.bin, 'mv', `
    const { spawnSync } = require('node:child_process')
    const args = process.argv.slice(2)
    if (['replace', 'restore'].includes(process.env.TEST_FAIL) && args[0].includes('/unpacked/')) process.exit(1)
    if (process.env.TEST_FAIL === 'restore' && args[0].endsWith('/previous.app')) process.exit(1)
    process.exit(spawnSync('/bin/mv', args, { stdio: 'inherit' }).status)
  `)
  f.run = (extra = {}) => spawnSync('/bin/bash', [], {
    input: readFileSync(path.join(root, 'install.sh')),
    encoding: 'utf8',
    detached: true,
    timeout: 15000,
    env: {
      ...process.env, HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TEST_DIR: f.dir, TEST_OS: platform, TEST_ARCH: arch, ...extra,
    },
  })
  f.destination = platform === 'Darwin'
    ? path.join(f.home, 'Applications', 'Pi Desktop.app')
    : path.join(f.home, '.local', 'share', 'pi-desktop', 'Pi-Desktop.AppImage')
  return f
}

function succeeded(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error || ''))
}
function failed(result, message) {
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, message)
}
function noStaging(f) {
  assert.equal(readdirSync(path.dirname(f.destination)).some((name) => name.startsWith('.pi-desktop-install.')), false)
}

const shellTest = (name, fn) => test(name, { skip: windows }, fn)

shellTest('piped Linux install selects an alpha asset, verifies it, and installs a FUSE-free launcher', (t) => {
  const f = shellFixture(t)
  succeeded(f.run())
  assert.deepEqual(readFileSync(f.destination), payload)
  assert.match(readFileSync(path.join(f.home, '.local/bin/pi-desktop'), 'utf8'), /APPIMAGE_EXTRACT_AND_RUN=1/)
  assert.match(readFileSync(path.join(f.dir, 'requests'), 'utf8'), /v1\.2\.3-alpha/)
  noStaging(f)
})

shellTest('Linux launcher forwards arguments and sets AppImage extraction mode', (t) => {
  const f = shellFixture(t)
  succeeded(f.run())
  writeFileSync(f.destination, '#!/bin/sh\nprintf "%s\\n" "$APPIMAGE_EXTRACT_AND_RUN" "$@"\n', { mode: 0o755 })
  const result = spawnSync(path.join(f.home, '.local/bin/pi-desktop'), ['a file', '--test'], {
    encoding: 'utf8', env: { ...process.env, HOME: f.home },
  })
  succeeded(result)
  assert.equal(result.stdout, '1\na file\n--test\n')
})

for (const failure of ['releases.json', 'checksum', 'payload']) {
  shellTest(`failed ${failure} download leaves an existing install untouched`, (t) => {
    const f = shellFixture(t)
    mkdirSync(path.dirname(f.destination), { recursive: true })
    writeFileSync(f.destination, 'old app')
    failed(f.run({ TEST_FAIL: failure }), /Download failed/)
    assert.equal(readFileSync(f.destination, 'utf8'), 'old app')
    noStaging(f)
  })
}

for (const checksum of ['invalid', '0'.repeat(64)]) {
  shellTest(`rejects ${checksum === 'invalid' ? 'malformed' : 'mismatched'} checksums before installation`, (t) => {
    const f = shellFixture(t)
    writeFileSync(path.join(f.dir, 'checksum'), checksum)
    failed(f.run(), /SHA-256/)
    assert.equal(existsSync(f.destination), false)
    noStaging(f)
  })
}

shellTest('missing release reports how to publish the fork and does not install an agent', (t) => {
  const f = shellFixture(t)
  writeFileSync(path.join(f.dir, 'releases.json'), '[]')
  failed(f.run(), /Publish a version tag/)
  assert.equal(readFileSync(path.join(f.dir, 'requests'), 'utf8').includes('pi.dev'), false)
  noStaging(f)
})

shellTest('rejects unsupported architecture before any download', (t) => {
  const f = shellFixture(t, 'Linux', 'aarch64')
  failed(f.run(), /No prebuilt installer/)
  assert.equal(existsSync(path.join(f.dir, 'requests')), false)
})

shellTest('ignores assets from other repositories', (t) => {
  const f = shellFixture(t)
  const metadata = readFileSync(path.join(f.dir, 'releases.json'), 'utf8').replaceAll('clasen/pi-desktop', 'other/pi-desktop')
  writeFileSync(path.join(f.dir, 'releases.json'), metadata)
  failed(f.run(), /No published/)
})

shellTest('noninteractive install skips optional agent installation', (t) => {
  const f = shellFixture(t)
  rmSync(path.join(f.bin, 'pi'))
  succeeded(f.run())
  assert.equal(readFileSync(path.join(f.dir, 'requests'), 'utf8').includes('pi.dev'), false)
})

for (const arch of ['arm64', 'x86_64']) {
  shellTest(`installs a macOS ${arch} bundle`, (t) => {
    const f = shellFixture(t, 'Darwin', arch)
    succeeded(f.run())
    assert.equal(readFileSync(path.join(f.destination, 'Contents/new'), 'utf8'), 'new app')
    noStaging(f)
  })
}

shellTest('Rosetta shells select the native arm64 Mac build', (t) => {
  const f = shellFixture(t, 'Darwin', 'arm64')
  succeeded(f.run({ TEST_ARCH: 'x86_64', TEST_ROSETTA: '1' }))
})

for (const failure of ['unpack', 'bundle', 'replace']) {
  shellTest(`macOS ${failure} failure preserves or restores the previous app`, (t) => {
    const f = shellFixture(t, 'Darwin', 'arm64')
    mkdirSync(f.destination, { recursive: true })
    writeFileSync(path.join(f.destination, 'old'), 'old app')
    failed(f.run({ TEST_FAIL: failure }), /Could not|does not contain/)
    assert.equal(readFileSync(path.join(f.destination, 'old'), 'utf8'), 'old app')
    noStaging(f)
  })
}

shellTest('a failed macOS rollback retains the backup and reports its location', (t) => {
  const f = shellFixture(t, 'Darwin', 'arm64')
  mkdirSync(f.destination, { recursive: true })
  writeFileSync(path.join(f.destination, 'old'), 'old app')
  failed(f.run({ TEST_FAIL: 'restore' }), /Restore the previous app from/)
  const stage = readdirSync(path.dirname(f.destination)).find((name) => name.startsWith('.pi-desktop-install.'))
  assert.ok(stage)
  assert.equal(readFileSync(path.join(path.dirname(f.destination), stage, 'previous.app', 'old'), 'utf8'), 'old app')
})

function windowsFixture(t) {
  const f = fixture(t, 'win-x64-setup.exe')
  const harness = path.join(f.dir, 'harness.ps1')
  writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
$env:PROCESSOR_ARCHITECTURE = $env:TEST_ARCH
Remove-Item Env:PROCESSOR_ARCHITEW6432 -ErrorAction SilentlyContinue
function Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    if ($Name -in @('pi', 'omp')) {
        if (-not $env:TEST_AGENT_MISSING) { [pscustomobject]@{ Name = $Name } }
        return
    }
    Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
}
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
    Add-Content -LiteralPath (Join-Path $env:TEST_DIR 'requests') -Value $Uri
    $Kind = if ($Uri.StartsWith('https://api.github.com/')) { 'releases.json' } elseif ($Uri.EndsWith('.sha256')) { 'checksum' } else { 'payload' }
    if ($env:TEST_FAIL -eq $Kind) { throw 'mock network error' }
    Copy-Item -LiteralPath (Join-Path $env:TEST_DIR $Kind) -Destination $OutFile
}
function Start-Process {
    param($FilePath, [switch]$Wait, [switch]$PassThru)
    Set-Content -LiteralPath (Join-Path $env:TEST_DIR 'started') -Value $FilePath
    [pscustomobject]@{ ExitCode = $(if ($env:TEST_FAIL -eq 'cancel') { 1 } else { 0 }) }
}
function Read-Host {
    if ($env:TEST_AGENT_MISSING) { return 'n' }
    throw 'Unexpected confirmation prompt'
}
& $env:TEST_INSTALLER
`)
  f.run = (extra = {}) => {
    const env = {
      ...process.env, TEMP: path.join(f.dir, 'temp'), TMP: path.join(f.dir, 'temp'),
      TEST_DIR: f.dir, TEST_INSTALLER: path.join(root, 'install.ps1'),
      TEST_ARCH: 'AMD64', ...extra,
    }
    // Windows PowerShell must load its own modules, not inherit PowerShell 7's.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'psmodulepath') delete env[key]
    }
    return spawnSync('powershell.exe', ['-NoProfile', '-File', harness], {
      encoding: 'utf8', timeout: 15000, env,
    })
  }
  return f
}
const windowsTest = (name, fn) => test(name, { skip: !windows }, fn)

windowsTest('Windows validates the download before opening the setup wizard and cleans up', (t) => {
  const f = windowsFixture(t)
  succeeded(f.run())
  assert.equal(existsSync(path.join(f.dir, 'started')), true)
  assert.deepEqual(readdirSync(path.join(f.dir, 'temp')), [])
})

for (const failure of ['releases.json', 'checksum', 'payload', 'cancel']) {
  windowsTest(`Windows reports ${failure} failure and cleans up`, (t) => {
    const f = windowsFixture(t)
    failed(f.run({ TEST_FAIL: failure }), /Download failed|exited with code/)
    assert.equal(existsSync(path.join(f.dir, 'started')), failure === 'cancel')
    assert.deepEqual(readdirSync(path.join(f.dir, 'temp')), [])
  })
}

windowsTest('Windows rejects corrupt downloads without executing them', (t) => {
  const f = windowsFixture(t)
  writeFileSync(path.join(f.dir, 'checksum'), '0'.repeat(64))
  failed(f.run(), /SHA-256 mismatch/)
  assert.equal(existsSync(path.join(f.dir, 'started')), false)
  assert.deepEqual(readdirSync(path.join(f.dir, 'temp')), [])
})

windowsTest('Windows rejects unsupported architectures before downloading', (t) => {
  const f = windowsFixture(t)
  failed(f.run({ TEST_ARCH: 'ARM64' }), /No prebuilt Windows installer for ARM64/)
  assert.equal(existsSync(path.join(f.dir, 'requests')), false)
})

windowsTest('Windows rejects asset URLs outside the fork', (t) => {
  const f = windowsFixture(t)
  const metadata = readFileSync(path.join(f.dir, 'releases.json'), 'utf8').replaceAll('clasen/pi-desktop', 'other/pi-desktop')
  writeFileSync(path.join(f.dir, 'releases.json'), metadata)
  failed(f.run(), /Unexpected installer URL/)
  assert.equal(existsSync(path.join(f.dir, 'started')), false)
})

windowsTest('Windows reports missing releases without launching an installer', (t) => {
  const f = windowsFixture(t)
  writeFileSync(path.join(f.dir, 'releases.json'), '[]')
  failed(f.run(), /Publish a version tag/)
  assert.equal(existsSync(path.join(f.dir, 'started')), false)
  assert.deepEqual(readdirSync(path.join(f.dir, 'temp')), [])
})

windowsTest('declining Pi on Windows leaves the installed app and does not download Pi', (t) => {
  const f = windowsFixture(t)
  const result = f.run({ TEST_AGENT_MISSING: '1' })
  succeeded(result)
  assert.match(result.stdout, /Skipped Pi installation/)
  assert.equal(readFileSync(path.join(f.dir, 'requests'), 'utf8').includes('pi.dev'), false)
})

test('release checksum generation hashes installer contents and ignores unrelated files', (t) => {
  const f = fixture(t, 'linux-x86_64.AppImage')
  const output = path.join(f.dir, 'release')
  mkdirSync(output)
  for (const ext of ['AppImage', 'exe', 'dmg', 'zip']) writeFileSync(path.join(output, `app.${ext}`), payload)
  writeFileSync(path.join(output, 'debug.yml'), 'not an installer')
  succeeded(spawnSync(process.execPath, [path.join(root, 'scripts/release-checksums.js'), output], { encoding: 'utf8' }))
  for (const ext of ['AppImage', 'exe', 'dmg', 'zip']) {
    assert.equal(readFileSync(path.join(output, `app.${ext}.sha256`), 'utf8'), `${digest}  app.${ext}\n`)
  }
  assert.equal(existsSync(path.join(output, 'debug.yml.sha256')), false)
})

test('release checksum generation fails on missing installers', (t) => {
  const f = fixture(t, 'linux-x86_64.AppImage')
  const output = path.join(f.dir, 'release')
  mkdirSync(output)
  failed(spawnSync(process.execPath, [path.join(root, 'scripts/release-checksums.js'), output], { encoding: 'utf8' }), /No release installers/)
})
