---
name: image
description: Generate an image from a text brief when the user needs a new visual asset or illustration.
---

Use the App's `skill_run` tool with `skill: "image"` and a self-contained `prompt` describing the subject, composition, style and required text. Call `skill_read` first if more execution details are needed. Never request or embed API credentials: the App supplies the configured provider credentials.

The model ID is optional in the App settings. When blank, the App chooses from its locally cached provider catalog, preferring a recognized recent stable image-generation model. It queries the catalog only when this connection has no saved list; the user can refresh it manually in skill settings. Do not invent a model ID or put model-selection instructions in the visual prompt. An explicitly configured model takes precedence. The result reports the selected model; automatic selection does not imply the lowest price. If discovery fails, report the configuration error rather than trying multiple paid generations.

Return the generated artifact paths and describe the result. The files are saved on the Windows App machine; remote agents should use the project's Windows tools if they need to inspect them. Do not transfer full image bytes into chat or assume a Windows path is on the VPS.

Do not generate images when a text explanation or existing asset meets the request. Each invocation generates one image. The App enforces the shared per-user-task call limit; retries consume that same budget. Reuse a request ID when retrying an uncertain submission, and report an unknown outcome instead of silently submitting the same paid request again.
