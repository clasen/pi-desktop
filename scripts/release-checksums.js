#!/usr/bin/env node
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { readdir, writeFile } = require('node:fs/promises')
const path = require('node:path')

async function writeChecksums(directory) {
  const files = (await readdir(directory)).filter((name) => /\.(AppImage|exe|dmg|zip)$/.test(name))
  if (files.length === 0) throw new Error(`No release installers found in ${directory}`)
  for (const name of files) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk)
    await writeFile(path.join(directory, `${name}.sha256`), `${hash.digest('hex')}  ${name}\n`)
  }
}

writeChecksums(process.argv[2] || 'release').catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
