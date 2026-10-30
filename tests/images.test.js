import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-qq-images-'))
const { downloadImages } = await import('../lib/index.js')

test('下载 OneBot 图片并保存到本地', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(png)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const files = await downloadImages([{ type: 'image', data: { url: `http://127.0.0.1:${port}/food.png` } }])
    assert.equal(files.length, 1)
    assert.ok(existsSync(files[0]))
    assert.ok(files[0].endsWith('.png'))
    assert.deepEqual(readFileSync(files[0]), png)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
