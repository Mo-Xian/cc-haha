import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildChatCompletionsUrl,
  extractAnswer,
  IMAGE_READ_DEFAULT_QUESTION,
  recognizeImage,
} from './recognizeImage.js'

// A fetch that fails loudly if the network path is ever reached — used to
// guarantee "not configured" tests short-circuit before any network call.
const neverFetch = (() => {
  throw new Error('network should not be reached when ImageRead is not configured')
}) as typeof fetch

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  // Snapshot and fully scrub the recognition-related env (both the legacy
  // global IMAGE_READ_* keys and the provider-projected CC_HAHA_IMAGE_READ_*
  // keys) so nothing leaks between tests.
  savedEnv = { ...process.env }
  delete process.env.IMAGE_READ_API_KEY
  delete process.env.IMAGE_READ_BASE_URL
  delete process.env.IMAGE_READ_MODEL
  delete process.env.OPENAI_API_KEY
  delete process.env.API_TIMEOUT_MS
  delete process.env.CC_HAHA_IMAGE_READ_PROVIDER_ID
  delete process.env.CC_HAHA_IMAGE_READ_BASE_URL
  delete process.env.CC_HAHA_IMAGE_READ_API_KEY
  delete process.env.CC_HAHA_IMAGE_READ_MODEL
})

afterEach(() => {
  process.env = { ...savedEnv }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('buildChatCompletionsUrl', () => {
  test('handles a bare root base URL', () => {
    expect(buildChatCompletionsUrl('https://host.example.com/openai')).toBe(
      'https://host.example.com/openai/chat/completions',
    )
  })

  test('handles an already fully-qualified chat endpoint', () => {
    expect(
      buildChatCompletionsUrl('https://host.example.com/openai/chat/completions'),
    ).toBe('https://host.example.com/openai/chat/completions')
  })

  test('strips trailing slashes', () => {
    expect(buildChatCompletionsUrl('https://host.example.com/openai/')).toBe(
      'https://host.example.com/openai/chat/completions',
    )
  })
})

describe('extractAnswer', () => {
  test('prefers content over reasoning_content', () => {
    expect(
      extractAnswer({
        content: 'the image is a red square',
        reasoning_content: 'thinking about it...',
      }),
    ).toBe('the image is a red square')
  })

  test('falls back to reasoning_content when content is empty', () => {
    expect(
      extractAnswer({ content: '', reasoning_content: 'fallback answer' }),
    ).toBe('fallback answer')
  })
})

describe('recognizeImage', () => {
  test('returns a helpful reason when no API key is configured', async () => {
    // beforeEach already cleared IMAGE_READ_API_KEY and OPENAI_API_KEY. Pass a
    // fetchImpl that throws: if the early-return is missed this fails loudly.
    const result = await recognizeImage(
      'data:image/png;base64,AAAA',
      undefined,
      neverFetch,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('IMAGE_READ_API_KEY')
    }
  })

  test('recognizes via content and sends the default question', async () => {
    process.env.IMAGE_READ_API_KEY = 'sk-test'
    process.env.IMAGE_READ_BASE_URL = 'https://gw.example.com/openai'

    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'It is a red square.',
            },
          },
        ],
      })
    }) as typeof fetch

    const result = await recognizeImage(
      'data:image/png;base64,AAAA',
      undefined,
      fetchImpl,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toBe('It is a red square.')
    }
    expect(captured?.url).toBe('https://gw.example.com/openai/chat/completions')

    const body = JSON.parse(captured!.init!.body as string)
    expect(body.model).toBe('qwen3-vl-30b-a3b-thinking')
    const content = body.messages[0].content
    expect(content[0].type).toBe('image_url')
    expect(content[1].type).toBe('text')
    expect(content[1].text).toBe(IMAGE_READ_DEFAULT_QUESTION)
    expect((captured!.init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    )
  })

  test('prefers the provider-projected env over the legacy global env', async () => {
    // Both configured: the provider CC_HAHA_IMAGE_READ_* keys must win.
    process.env.CC_HAHA_IMAGE_READ_PROVIDER_ID = 'provider-vision'
    process.env.CC_HAHA_IMAGE_READ_BASE_URL = 'https://provider-vision.example.com/openai'
    process.env.CC_HAHA_IMAGE_READ_API_KEY = 'provider-secret'
    process.env.CC_HAHA_IMAGE_READ_MODEL = 'qwen3-vl-30b-a3b-thinking'
    process.env.IMAGE_READ_API_KEY = 'legacy-secret'

    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'provider answer' } }],
      })
    }) as typeof fetch

    const result = await recognizeImage('data:image/png;base64,AAAA', undefined, fetchImpl)
    expect(result.ok).toBe(true)
    expect(captured?.url).toBe(
      'https://provider-vision.example.com/openai/chat/completions',
    )
    const body = JSON.parse(captured!.init!.body as string)
    expect(body.model).toBe('qwen3-vl-30b-a3b-thinking')
    expect((captured!.init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer provider-secret',
    )
  })

  test('falls back to reasoning_content for thinking models', async () => {
    process.env.IMAGE_READ_API_KEY = 'sk-test'
    const fetchImpl = (async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'final: it is blue',
            },
          },
        ],
      })) as typeof fetch

    const result = await recognizeImage(
      'data:image/png;base64,AAAA',
      'what color?',
      fetchImpl,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toBe('final: it is blue')
    }
  })

  test('returns a redacted reason on upstream HTTP error', async () => {
    process.env.IMAGE_READ_API_KEY = 'sk-secret-123'
    const fetchImpl = (async () =>
      new Response('upstream sk-secret-123 leaked', { status: 400 })) as typeof fetch

    const result = await recognizeImage('data:image/png;base64,AAAA', undefined, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).not.toContain('sk-secret-123')
      expect(result.reason).toContain('HTTP 400')
    }
  })
})
