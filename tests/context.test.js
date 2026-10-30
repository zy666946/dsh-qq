import { test } from 'node:test'
import assert from 'node:assert/strict'

import { summarizeContext } from '../lib/index.js'

test('上下文用量：totalTokens / contextWindow', () => {
  const info = summarizeContext({
    contextWindow: 1_000_000,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 98_500, cacheWriteTokens: 0, totalTokens: 100_000 },
    updatedAt: 123,
  })
  assert.equal(info.contextWindow, 1_000_000)
  assert.equal(info.usedTokens, 100_000)
  assert.equal(info.percent, 10)
  assert.equal(info.updatedAt, 123)
})

test('上下文用量：缺 totalTokens 时用各项相加', () => {
  const info = summarizeContext({
    contextWindow: 2000,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 850, cacheWriteTokens: 0 },
  })
  assert.equal(info.usedTokens, 1000)
  assert.equal(info.percent, 50)
})

test('上下文用量：窗口缺失时用 fallback，0 不报错', () => {
  assert.equal(summarizeContext({ usage: { totalTokens: 10 } }, 1000).percent, 1)
  assert.equal(summarizeContext({}, 0).contextWindow, 0)
  assert.equal(summarizeContext({}, 0).percent, 0)
  assert.equal(summarizeContext(undefined, undefined).usedTokens, 0)
})
