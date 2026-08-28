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
 * description, passing through all other blocks in order. Used on the paste
 * path so the resulting message only carries one image → text description,
 * letting a non-visual main model (e.g. DeepSeek) understand the image.
 */
export async function replaceImageBlocksWithText(
  blocks: ContentBlockParam[],
): Promise<ContentBlockParam[]> {
  // Not configured — leave image blocks unchanged so a vision-capable main
  // model can still receive them directly.
  if (!isImageRecognitionConfigured()) {
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
