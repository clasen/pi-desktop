import assert from 'node:assert/strict'
import { test } from 'node:test'
import { droppedComposerItems, insertFolderReferences, readDroppedAttachment } from './dropped-attachments'

const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })

test('mixed drops preserve files as attachments and folders as path references', async () => {
  const image = new File(['image'], 'photo.png')
  const folder = new File([], 'folder')
  const probed: string[] = []
  assert.deepEqual(await droppedComposerItems({
    types: ['Files'],
    items: [
      { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false, isFile: true }) },
      { kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }) },
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => image, webkitGetAsEntry: () => null },
    ],
  }, (file) => `/tmp/${file.name}`, async (path) => {
    probed.push(path)
    return { exists: true, isDirectory: false }
  }), [
    { kind: 'file', file, path: '/tmp/notes.txt' },
    { kind: 'folder', path: '/tmp/folder' },
    { kind: 'file', file: image, path: '/tmp/photo.png' },
  ])
  assert.deepEqual(probed, ['/tmp/photo.png'])
})

test('unknown and files-only drag sources classify folders without reading their contents', async () => {
  const folder = new File([], 'folder')
  const getPath = (file: File): string => `/tmp/${file.name}`
  const pathKind = async (path: string) => ({ exists: true, isDirectory: path === '/tmp/folder' })
  assert.deepEqual(await droppedComposerItems({
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => null }],
  }, getPath, pathKind), [{ kind: 'folder', path: '/tmp/folder' }])
  assert.deepEqual(await droppedComposerItems({ types: ['Files'], files: [folder, file] }, getPath, pathKind), [
    { kind: 'folder', path: '/tmp/folder' },
    { kind: 'file', file, path: '/tmp/notes.txt' },
  ])
  assert.deepEqual(await droppedComposerItems({ types: ['Files'] }, getPath, pathKind), [])
})

test('drop entries and paths are captured before asynchronous classification', async () => {
  let readable = true
  const result = droppedComposerItems({
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => { assert.ok(readable); return file } }],
  }, (file) => { assert.ok(readable); return `/tmp/${file.name}` }, async () => {
    await Promise.resolve()
    assert.equal(readable, false)
    return { exists: true, isDirectory: false }
  })
  readable = false
  assert.deepEqual(await result, [{ kind: 'file', file, path: '/tmp/notes.txt' }])
})

test('pathless browser files remain attachments but folders need a real path', async () => {
  const pathKind = async () => { throw new Error('must not probe an empty path') }
  assert.deepEqual(await droppedComposerItems({ types: ['Files'], files: [file] }, () => '', pathKind), [
    { kind: 'file', file, path: '' },
  ])
  await assert.rejects(droppedComposerItems({
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: true, isFile: false }) }],
  }, () => '', pathKind), /Could not attach file/)
})

test('folder references replace the selection, separate adjacent text, and position the caret', () => {
  assert.deepEqual(insertFolderReferences('Review this please', 7, 11, ['/tmp/project']), {
    value: 'Review @/tmp/project  please', caret: 21,
  })
  assert.deepEqual(insertFolderReferences('beforeafter', 6, 6, ['/tmp/one', '/tmp/two']), {
    value: 'before @/tmp/one @/tmp/two after', caret: 27,
  })
})

test('folder references quote paths with spaces or quotes on Unix and Windows', () => {
  const paths = ['/tmp/my project', 'C:\\Users\\My Name\\project', '/tmp/a"b']
  const expected = paths.map((path) => `@${JSON.stringify(path)}`).join(' ') + ' '
  assert.deepEqual(insertFolderReferences('', 0, 0, paths), { value: expected, caret: expected.length })
})

test('UTF-8 documents and code are read directly from the granted File', async () => {
  assert.deepEqual(await readDroppedAttachment(file), { kind: 'text', name: 'notes.txt', content: 'hello' })
  assert.deepEqual(await readDroppedAttachment(new File(['¡Hola! 日本語'], 'code.ts')), {
    kind: 'text', name: 'code.ts', content: '¡Hola! 日本語',
  })
  assert.equal((await readDroppedAttachment(new File([], 'empty.txt'))).kind, 'text')
  assert.equal((await readDroppedAttachment(new File(['<svg/>'], 'drawing.svg', { type: 'image/svg+xml' }))).kind, 'text')
})

test('supported images become base64 blocks, even when the OS omits MIME type', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255])
  assert.deepEqual(await readDroppedAttachment(new File([bytes], 'PHOTO.PNG')), {
    kind: 'image', name: 'PHOTO.PNG',
    image: { type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') },
  })
  assert.equal((await readDroppedAttachment(new File([bytes], 'photo', { type: 'image/jpeg' }))).kind, 'image')
})

test('binary documents and unsupported images fail instead of inlining corrupt text', async () => {
  for (const unsupported of [
    new File(['%PDF-1.7\n'], 'document.pdf'),
    new File(['PK\x03\x04\0'], 'document.docx'),
    new File([new Uint8Array([255, 254])], 'binary.dat'),
    new File(['BM\0'], 'image.bmp', { type: 'image/bmp' }),
  ]) {
    await assert.rejects(readDroppedAttachment(unsupported), /Unsupported file format/)
  }
})

test('oversized attachments are rejected before reading', async () => {
  await assert.rejects(readDroppedAttachment({
    size: 25 * 1024 * 1024 + 1,
    arrayBuffer: () => { throw new Error('must not read') },
  } as unknown as File), /too large/i)
})

test('unusual filenames cannot match inherited image MIME map properties', async () => {
  assert.equal((await readDroppedAttachment(new File(['text'], 'file.constructor'))).kind, 'text')
})
