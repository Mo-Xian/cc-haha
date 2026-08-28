import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { replaceImageBlocksWithText } from './imageRecognition.js'

let savedEnv: NodeJS.ProcessEnv

let imageCounter = 0
function pngBlock(): ContentBlockParam {
  imageCounter += 1
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from(`img-${imageCounter}`).toString('base64'),
    },
  }
}

beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env.IMAGE_READ_API_KEY
  delete process.env.IMAGE_READ_BASE_URL
  delete process.env.IMAGE_READ_MODEL
  delete process.env.OPENAI_API_KEY
})

afterEach(() => {
  process.env = { ...savedEnv }
})

describe('replaceImageBlocksWithText', () => {
  test('keeps image blocks unchanged when recognition is not configured', async () => {
    const blocks: ContentBlockParam[] = [pngBlock(), { type: 'text', text: 'hi' }]
    const out = await replaceImageBlocksWithText(blocks)
    expect(out).toEqual(blocks)
  })

  test('rewrites image blocks to text descriptions when configured (success)', async () => {
    process.env.IMAGE_READ_API_KEY = 'sk-test'

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'a red square' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch
    try {
      const sameImage: ContentBlockParam = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: Buffer.from('same').toString('base64') },
      }
      const blocks: ContentBlockParam[] = [
        sameImage,
        { type: 'text', text: 'keep me' },
        sameImage, // duplicate image → served from cache, same text
      ]
      const out = await replaceImageBlocksWithText(blocks)
      expect(out).toHaveLength(3)
      expect(out[0]).toEqual({ type: 'text', text: 'a red square' })
      expect(out[1]).toEqual({ type: 'text', text: 'keep me' })
      expect(out[2]).toEqual({ type: 'text', text: 'a red square' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rewrites image blocks to a placeholder text on recognition failure', async () => {
    process.env.IMAGE_READ_API_KEY = 'sk-test'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('server error', { status: 500 })) as typeof fetch
    try {
      const out = await replaceImageBlocksWithText([pngBlock()])
      expect(out[0]).toMatchObject({ type: 'text' })
      expect((out[0] as { text: string }).text).toContain('could not be auto-described')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
