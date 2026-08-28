import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { IMAGE_READ_TOOL_NAME } from './constants.js'
import { IMAGE_READ_DESCRIPTION } from './prompt.js'
import { recognizeImage } from './recognizeImage.js'

const inputSchema = lazySchema(() =>
  z
    .object({
      image: z
        .string()
        .describe(
          'The image to recognize: a local file path, an http(s) URL, or a base64 data URI (data:image/...;base64,...)',
        ),
      question: z
        .string()
        .describe(
          'Optional. The specific question to ask about the image. When omitted, return a general description.',
        )
        .optional(),
    })
    .strict(),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    result: z.string().describe('The vision model text answer about the image'),
    durationMs: z
      .number()
      .describe('Time taken to load the image and call the vision model'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type ImageReadOutput = z.infer<OutputSchema>

type ImageReadInput = {
  image: string
  question?: string
}

export const ImageReadTool = buildTool({
  name: IMAGE_READ_TOOL_NAME,
  searchHint: 'recognize and describe an image using a vision model',
  maxResultSizeChars: 50_000,
  alwaysLoad: true,
  async description(input) {
    const { image } = input as ImageReadInput
    const short = image.length > 60 ? `${image.slice(0, 57)}...` : image
    return `Claude wants to recognize the image: ${short}`
  },
  userFacingName() {
    return 'ImageRead'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isEnabled() {
    // The tool is always available; when not configured it returns a helpful
    // message telling the user to set IMAGE_READ_*.
    return true
  },
  toAutoClassifierInput(input) {
    return `Recognize image: ${(input as { image?: string }).image ?? ''}`
  },
  async checkPermissions(input) {
    return {
      behavior: 'allow' as const,
      updatedInput: input,
      decisionReason: { type: 'other' as const, reason: 'Read-only image tool' },
    }
  },
  async prompt() {
    return IMAGE_READ_DESCRIPTION
  },
  renderToolUseMessage() {
    return null
  },
  async validateInput(input) {
    const { image } = input
    if (!image || typeof image !== 'string' || image.trim() === '') {
      return {
        result: false,
        message: 'Error: the `image` parameter must be a non-empty string.',
        meta: { reason: 'empty_image' },
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async call({ image, question }) {
    const start = Date.now()
    const outcome = await recognizeImage(image, question)

    if (!outcome.ok) {
      return {
        data: {
          result: `ImageRead is not configured or failed: ${outcome.reason}`,
          durationMs: Date.now() - start,
        },
      }
    }

    return {
      data: {
        result: outcome.text,
        durationMs: Date.now() - start,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, ImageReadOutput>)
