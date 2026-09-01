import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  isImageRecognitionConfigured,
  recognizeImage,
} from '../tools/ImageReadTool/recognizeImage.js'
import { hashContent } from './hash.js'

// Known non-visual (text-only) reasoning model families. These models cannot
// accept image blocks, so for them pasted / attached images must be rewritten
// to text (or a placeholder) before reaching the main model — otherwise a
// text-only gateway rejects the request with HTTP 400.
const NON_VISUAL_MODEL_FAMILIES: ReadonlyArray<(modelId: string) => boolean> = [
  // deepseek: deepseek-v4*, deepseek-chat, deepseek-reasoner
  modelId => modelId.startsWith('deepseek-v4') || modelId === 'deepseek-chat' || modelId === 'deepseek-reasoner',
  // kimi text / coding models
  modelId => (
    modelId === 'k3' ||
    modelId.startsWith('k3-') ||
    modelId.startsWith('kimi-k3') ||
    modelId.startsWith('kimi-for-coding') ||
    modelId.startsWith('kimi-k2.')
  ),
]

/**
 * Rewrite-image override: set IMAGE_READ_TEXT_ONLY=1 (or "true") to force image
 * downgrade even when the main model id is not recognised as a non-visual
 * family. Visual main models keep receiving real images by default.
 */
function isTextOnlyOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.IMAGE_READ_TEXT_ONLY?.trim().toLowerCase()
  return value === '1' || value === 'true'
}

/**
 * Whether a model id is a known non-visual (text-only) model that must not
 * receive image blocks. Pure — shared by the CLI rewrite path and the server
 * proxy fallback.
 */
export function isNonVisualModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  if (!normalized) return false
  return NON_VISUAL_MODEL_FAMILIES.some(match => match(normalized))
}

/**
 * Whether the given main model id (defaults to the active ANTHROPIC_MODEL) is a
 * known non-visual (text-only) model that must not receive image blocks. A
 * visual main model returns false so real images still reach it.
 */
export function shouldRewriteImagesForMainModel(
  modelId = process.env.ANTHROPIC_MODEL ?? '',
): boolean {
  if (isTextOnlyOverride()) return true
  return isNonVisualModelId(modelId)
}

// Module-level memory cache: the same image (keyed by its base64 content hash)
// is only recognized once per process. The paste path rewrites image blocks to
// text which then persists with the history, so this cache avoids repeat
// network recognition when the same image is pasted again / across turns.
const cache = new Map<string, string>()

function buildDataUri(block: ImageBlockParam): string | null {
  const source = block.source as Base64ImageSource | undefined
  if (!source || source.type !== 'base64' || typeof source.data !== 'string') {
    return null
  }
  const mediaType = source.media_type || 'image/png'
  return `data:${mediaType};base64,${source.data}`
}

/**
 * Recognize a single image (as a data URI) into a text description. Never
 * throws — on failure returns a placeholder string.
 */
export async function describeImage(dataUri: string): Promise<string> {
  const key = hashContent(dataUri)
  const cached = cache.get(key)
  if (cached !== undefined) {
    return cached
  }

  const outcome = await recognizeImage(dataUri)
  if (outcome.ok) {
    cache.set(key, outcome.text)
    return outcome.text
  }

  // Rough byte count (base64: every 4 chars ≈ 3 bytes) for the placeholder.
  const comma = dataUri.indexOf(',')
  const b64 = comma >= 0 ? dataUri.slice(comma + 1) : ''
  const approxBytes = Math.floor((b64.length * 3) / 4)
  return (
    `[Image pasted (base64, ${approxBytes} bytes) — could not be auto-described: ` +
    `${outcome.reason}. Set IMAGE_READ_API_KEY (and optionally IMAGE_READ_BASE_URL / IMAGE_READ_MODEL) to enable it, or use the ImageRead tool.]`
  )
}

/**
 * Replace every image block in a content array with its recognized text
 * description, passing through all other blocks in order. Used so the resulting
 * message only carries one image → text description, letting a non-visual main
 * model (e.g. DeepSeek) understand the image.
 *
 * When `forceRewrite` is not set (the default), images are only rewritten when
 * recognition is configured — vision-capable main models keep receiving real
 * image blocks. When the active main model is itself non-visual
 * (shouldRewriteImagesForMainModel), rewrite is applied even without
 * recognition, falling back to a placeholder description instead of sending a
 * real image that a text-only gateway would reject.
 */
export async function replaceImageBlocksWithText(
  blocks: ContentBlockParam[],
  forceRewrite = shouldRewriteImagesForMainModel(),
): Promise<ContentBlockParam[]> {
  // Neither recognition nor a non-visual main model requires a rewrite — leave
  // image blocks unchanged so a vision-capable main model can still receive
  // them directly.
  if (!isImageRecognitionConfigured() && !forceRewrite) {
    return blocks
  }
  const out: ContentBlockParam[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      const dataUri = buildDataUri(block)
      const text = dataUri
        ? await describeImage(dataUri)
        : '[Image pasted — could not be auto-described]'
      out.push({ type: 'text', text })
    } else {
      out.push(block)
    }
  }
  return out
}
