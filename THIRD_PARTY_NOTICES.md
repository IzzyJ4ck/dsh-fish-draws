# Third-party notices and redistribution status

The original code of `@izzyj4ck/dsh-fish-draws` is intended to be licensed
under the MIT License. That license does **not** by itself license third-party
workflow or prompt material.

## Qwen Image 2.1 workflow and prompt references

- Known explanatory source: <https://www.bilibili.com/video/BV1HVhX6AEC6/>
- The current `qwen21-unified-api.json` evolved from a workflow shared for free
  by the video's author through RunningHub.
- The current system-prompt references were informed by text shared with that
  workflow.
- The exact RunningHub artifact URL and a written redistribution grant have not
  yet been recorded.

### Current status

Public redistribution is **not cleared**. Local development and testing are
allowed by the project owner, but this package must not be publicly published
until one of the following is complete:

1. The original author provides written permission covering modification,
   public redistribution, packaging on GitHub/npm, commercial use, and any
   attribution requirements; or
2. The workflow is independently rebuilt from clearly licensed official
   materials and both system prompts are rewritten from scratch.

The machine-readable gate is stored in
`assets/licensing/redistribution-status.json`. Release checks must fail while
`redistribution_approved` is false.
