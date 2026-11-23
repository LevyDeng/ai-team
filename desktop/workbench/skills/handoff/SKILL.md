---
name: handoff
description: Write a task handoff for selected roles in another ai-team conversation.
---

Use this skill when the user asks you to hand off a task to another ai-team conversation. Call `skill_handoff_targets` to find the requested conversation and its available roles. Use the requested recipients. If the destination or recipients are ambiguous, ask the user to choose, unless they have delegated the choice to you.

Write a self-contained prompt in the user's language. Include the objective, relevant decisions and constraints, exact paths or references if useful, remaining work, and how the recipients should verify it. Include only context needed for this task. Do not include credentials, an entire transcript, or routing mentions in the prompt.

Call `skill_handoff_prepare` with the destination chat ID, recipient IDs, the written prompt, and a unique request ID. Reuse that request ID if you are unsure whether the call succeeded. ai-team will show a review card in the current chat. Tell the user the task is ready to review. The recipient roles start only after the user sends the draft.
