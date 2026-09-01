import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { replaceImageBlocksWithText } from '../imageRecognition.js'
import { processTextPrompt } from './processTextPrompt.js'

let savedEnv: NodeJS.ProcessEnv

function pngBlock(data: string): ContentBlockParam {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  }
}

function messageContent(
  res: Awaited<ReturnType<typeof processTextPrompt>>,
): ContentBlockParam[] {
  const msg = res.messages[0] as { message?: { content?: ContentBlockParam[] } }
  const content = msg.message?.content ?? []
  return content
}

beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env.IMAGE_READ_API_KEY
  delete process.env.IMAGE_READ_BASE_URL
  delete process.env.IMAGE_READ_MODEL
  delete process.env.IMAGE_READ_TEXT_ONLY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_MODEL
})

afterEach(() => {
  process.env = { ...savedEnv }
})

describe('array-input image downgrade (SDK/VS Code path)', () => {
  test('non-visual main model: array-input image is downgraded to text, not sent as a real image', async () => {
    process.env.ANTHROPIC_MODEL = 'deepseek-v4-flash-0731'
    // recognition NOT configured — must still downgrade rather than send a real image
    const inputWithImage: ContentBlockParam[] = [
      pngBlock(Buffer.from('imgdata').toString('base64')),
      { type: 'text', text: 'what is this?' },
    ]

    // Mirrors the processUserInputBase fix: downgrade array-input blocks first.
    const promptInput = await replaceImageBlocksWithText(inputWithImage)
    const res = processTextPrompt(promptInput, [], [], [], 'uuid-test')

    const content = messageContent(res)
    expect(content.some(block => block.type === 'image')).toBe(false)
    // Every image became a text placeholder.
    expect(content.filter(block => block.type === 'text').length).toBeGreaterThan(0)
    const placeholder = content.find(block => block.type === 'text' && block.text.includes('could not be auto-described'))
    expect(placeholder).toBeDefined()
  })

  test('recognition configured: array-input image is recognized into a description', async () => {
    process.env.IMAGE_READ_API_KEY = 'sk-test'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'a blue square' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch
    try {
      const inputWithImage: ContentBlockParam[] = [
        pngBlock(Buffer.from('imgdata').toString('base64')),
        { type: 'text', text: 'look at this' },
      ]
      const promptInput = await replaceImageBlocksWithText(inputWithImage)
      const res = processTextPrompt(promptInput, [], [], [], 'uuid-test')
      const content = messageContent(res)
      expect(content.some(block => block.type === 'image')).toBe(false)
      expect(content.some(block => block.type === 'text' && block.text === 'a blue square')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('visual / unknown main model keeps real image blocks when recognition is off', async () => {
    // no ANTHROPIC_MODEL + no image-read config → visual behaviour: keep image
    const inputWithImage: ContentBlockParam[] = [
      pngBlock(Buffer.from('imgdata').toString('base64')),
      { type: 'text', text: 'hi' },
    ]
    const promptInput = await replaceImageBlocksWithText(inputWithImage)
    const res = processTextPrompt(promptInput, [], [], [], 'uuid-test')
    const content = messageContent(res)
    expect(content.some(block => block.type === 'image')).toBe(true)
  })
})
