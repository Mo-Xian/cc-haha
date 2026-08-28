export const IMAGE_READ_PROVIDER_ID_ENV_KEY =
  'CC_HAHA_IMAGE_READ_PROVIDER_ID'
export const IMAGE_READ_BASE_URL_ENV_KEY =
  'CC_HAHA_IMAGE_READ_BASE_URL'
export const IMAGE_READ_API_KEY_ENV_KEY =
  'CC_HAHA_IMAGE_READ_API_KEY'
export const IMAGE_READ_MODEL_ENV_KEY =
  'CC_HAHA_IMAGE_READ_MODEL'

export type ImageReadRuntimeConfig = {
  providerId: string
  model: string
  baseUrl?: string
  apiKey?: string
}

/**
 * Read the active provider's image-read (vision) runtime config from the
 * environment. `providerRuntimeEnv` projects a provider's `imageRead` field
 * into these CC_HAHA_IMAGE_READ_* keys before the CLI child is spawned.
 */
export function getImageReadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ImageReadRuntimeConfig | null {
  const providerId = env[IMAGE_READ_PROVIDER_ID_ENV_KEY]?.trim()
  const model = env[IMAGE_READ_MODEL_ENV_KEY]?.trim()

  if (!providerId || !model) {
    return null
  }

  const baseUrl = env[IMAGE_READ_BASE_URL_ENV_KEY]?.trim()
  const apiKey = env[IMAGE_READ_API_KEY_ENV_KEY]?.trim()

  return {
    providerId,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  }
}
