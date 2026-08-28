import { readFile } from 'node:fs/promises'
import { getImageReadRuntimeConfig } from '../../services/imageRead/config.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'

/**
 * Image-read (vision) model configuration. Resolved per active provider — the
 * provider's `imageRead` field is projected into CC_HAHA_IMAGE_READ_* env by
 * the server before the CLI child runs.
 *
 * CC_HAHA_IMAGE_READ_API_KEY  API key for the vision gateway endpoint.
 * CC_HAHA_IMAGE_READ_BASE_URL  Vision gateway base URL (or chat base URL).
 * CC_HAHA_IMAGE_READ_MODEL     The vision model to use.
 */
export type ImageReadConfig = {
  apiKey: string
  baseURL: string
  model: string
  timeoutMs: number
}

export const DEFAULT_IMAGE_READ_BASE_URL = 'https://aitools.chempartner.com/openai'
export const DEFAULT_IMAGE_READ_MODEL = 'qwen3-vl-30b-a3b-thinking'
export const DEFAULT_IMAGE_READ_TIMEOUT_MS = 120 * 1000

export function getImageReadConfig(): ImageReadConfig {
  // Prefer the active provider's imageRead config (projected as
  // CC_HAHA_IMAGE_READ_*).
  const runtime = getImageReadRuntimeConfig()
  if (runtime) {
    return {
      apiKey: runtime.apiKey?.trim() || '',
      baseURL: runtime.baseUrl?.trim() || DEFAULT_IMAGE_READ_BASE_URL,
      model: runtime.model.trim() || DEFAULT_IMAGE_READ_MODEL,
      timeoutMs: Number(process.env.API_TIMEOUT_MS) || DEFAULT_IMAGE_READ_TIMEOUT_MS,
    }
  }

  // Fallback: legacy global IMAGE_READ_* env (users who configured it directly).
  return {
    apiKey:
      process.env.IMAGE_READ_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      '',
    baseURL:
      process.env.IMAGE_READ_BASE_URL?.trim() || DEFAULT_IMAGE_READ_BASE_URL,
    model: process.env.IMAGE_READ_MODEL?.trim() || DEFAULT_IMAGE_READ_MODEL,
    timeoutMs: Number(process.env.API_TIMEOUT_MS) || DEFAULT_IMAGE_READ_TIMEOUT_MS,
  }
}

/**
 * Whether image recognition is configured. When false, pasted images should be
 * left unchanged rather than rewritten to a placeholder.
 */
export function isImageRecognitionConfigured(): boolean {
  return Boolean(getImageReadConfig().apiKey)
}

/**
 * Turn the `image` input into an OpenAI image_url URL.
 * Accepts: base64 data URI, http(s) URL (fetched server-side by the gateway),
 * or a local file path (read + base64-encoded here).
 */
async function toOpenAIImageUrl(image: string): Promise<string> {
  if (image.startsWith('data:')) return image
  if (/^https?:\/\//i.test(image)) return image
  const buf = await readFile(image)
  return `data:${guessMediaType(image)};base64,${buf.toString('base64')}`
}

function guessMediaType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.jfif')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  return 'image/png'
}

/**
 * Resolve the concrete Chat Completions endpoint from an OpenAI-compatible
 * base URL. Handles both a bare root (https://host/v1) and a full flat-mount
 * endpoint (…/v1/chat/completions).
 */
export function buildChatCompletionsUrl(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return `${trimmed}/chat/completions`
}

/**
 * qwen3-vl is a *thinking* model. Its returned message may include a
 * `reasoning_content` field; prefer the real answer text over reasoning.
 */
export function extractAnswer(message: {
  content?: unknown
  reasoning_content?: unknown
}): string {
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content.trim()
  }
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    return message.reasoning_content.trim()
  }
  return ''
}

export const IMAGE_READ_DEFAULT_QUESTION =
  '请详细描述这张图片的内容，包括其中的文字、物体、人物和场景。'

const MAX_ERROR_BODY_CHARS = 500

/**
 * Recognize an image via the IMAGE_READ_* vision gateway.
 *
 * @param imageUrlOrDataUri a base64 data URI, http(s) URL, or local file path.
 * @param question optional custom question; defaults to a full description.
 * @returns a discriminated union. Never throws — callers shape their own
 *   fallback strings on `{ ok: false }`.
 */
export async function recognizeImage(
  imageUrlOrDataUri: string,
  question?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const config = getImageReadConfig()

  if (!config.apiKey) {
    return {
      ok: false,
      reason:
        'IMAGE_READ_API_KEY is not set. Set IMAGE_READ_API_KEY (and optionally IMAGE_READ_BASE_URL / IMAGE_READ_MODEL) to enable image recognition.',
    }
  }

  let imageUrl: string
  try {
    imageUrl = await toOpenAIImageUrl(imageUrlOrDataUri)
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const userPrompt =
    question && question.trim() ? question.trim() : IMAGE_READ_DEFAULT_QUESTION

  const url = buildChatCompletionsUrl(config.baseURL)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: imageUrl } },
                { type: 'text', text: userPrompt },
              ],
            },
          ],
        }),
        signal: controller.signal,
        ...getProxyFetchOptions({ targetUrl: url }),
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      return {
        ok: false,
        reason: `vision gateway returned HTTP ${response.status}: ${safeUpstreamError(errorBody, config.apiKey)}`,
      }
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>
    }
    const answer = extractAnswer(payload.choices?.[0]?.message ?? {})
    if (!answer) {
      return { ok: false, reason: 'vision model returned no valid text' }
    }
    return { ok: true, text: answer }
  } catch (reason) {
    return {
      ok: false,
      reason: reason instanceof Error ? reason.message : String(reason),
    }
  }
}

function safeUpstreamError(body: string, secret: string): string {
  const redacted = secret
    ? body.split(secret).join('[redacted]')
    : body
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_BODY_CHARS)
}
