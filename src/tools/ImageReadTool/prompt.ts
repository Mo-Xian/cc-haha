export const IMAGE_READ_DESCRIPTION = `
- Recognizes / describes the content of an image using a dedicated vision model (qwen3-vl)
- Takes an image reference (local file path, http(s) URL, or base64 data URI) plus an optional question
- The main model (DeepSeek) has NO vision capability, so use this tool whenever the user asks
  you to "look at", "read", or "see" an image, a screenshot, or picture content
- Sends the image to the vision model and returns its textual description / answer

Input:
  - image: the image to recognize. One of:
      * a local file path (e.g. /path/to/photo.png, C:\\Users\\x\\shot.png)
      * an http(s) URL pointing to an image file
      * a base64 data URI (data:image/png;base64,....)
  - question: optional. The specific question to ask about the image. When omitted,
      the tool returns a general description of the image contents.

Usage notes:
  - The tool only recognizes ONE image per call. If there are multiple images, call it
    once per image.
  - Local paths must point to an existing readable file.
  - When a user pastes or refers to an image embedded in the conversation, the image on
    disk may be located in a temporary attachments directory — locate the file and pass
    its path here.
  - The tool is read-only and never modifies the image or any file.
  - The tool is independent from the main conversation model: it uses its own vision
    model configured via IMAGE_READ_API_KEY / IMAGE_READ_BASE_URL / IMAGE_READ_MODEL.
`
