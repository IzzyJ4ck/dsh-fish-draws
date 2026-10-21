# Strata prompt rewriting contract for Qwen-Image-2.1

This contract adapts the publicly documented Qwen-Image-2.1 T2I prompt-enhancer behavior to Strata. The dedicated PE checkpoint contains post-training that a system prompt cannot reproduce; therefore preserve this output contract and validate the result instead of claiming exact PE-model parity.

Do not copy the PE checkpoint's temperature, top-p, top-k, presence-penalty, or token-limit settings into Strata. Those sampling values were calibrated with the PE checkpoint's post-trained weights and chat template; changing Strata's global sampling is not an equivalent substitute.

## Output fields to prepare before calling the helper

- `expanded_prompt`: one continuous English description of the finished image.
- `aspect_ratio`: one supported ratio, separate from the description.
- `count`: the number of images explicitly requested; otherwise 1.
- `seed`: preserve a user-specified seed; otherwise omit it.

Do not include ratio, resolution, JSON labels, explanations, or renderer instructions inside `expanded_prompt`.

## Rewrite procedure

1. Split the request into immutable constraints and open details.
   - Immutable: exact visible text, named subjects, counts, colors, positions, relationships, style, exclusions, and any stated ratio.
   - Open: details the user left unspecified and that are necessary to make a coherent image.
   - Job instructions such as “make the text sharp” guide the description but are not objects in the scene.
2. Choose the frame.
   - Preserve a user-specified ratio.
   - Otherwise prefer `3:2` for ordinary horizontal scenes and `2:3` for ordinary vertical scenes.
   - Use `1:1` for square icons, badges, album covers, or centered emblems; `16:9` for cinematic/presentation frames; `9:16` for phone screens and tall banners. Use another supported ratio only when the subject calls for it.
3. Open with the medium, style, main subject, orientation, and background or palette.
4. Make an internal inventory of every visible element and assign it a place in the frame. For multi-region layouts, walk background → top → left/center/right → bottom. For one dominant subject, walk background → pose/placement → face/head → body/materials → held/touching objects → edges.
5. Preserve every requested visible string character-for-character and in its original script. Put each visible string in straight double quotes and describe its location, size, weight, and color. Do not invent readable text when none was requested.
6. State lighting explicitly: source, direction, softness/hardness, shadows, and highlights.
7. Close with one whole-frame sentence covering balance, palette, style, and mood.
8. Self-check before the tool call:
   - No immutable constraint was dropped, translated, renumbered, or contradicted.
   - Added details do not change the user's intent.
   - Objects have consistent scale, lighting, shadows, and reflections.
   - No empty quality slogans such as “masterpiece”, “best quality”, or “8K”.
   - No mention of an AI, renderer, prompt, pixel dimensions, or aspect-ratio numbers.

## Detail level

- Sparse request: normally 250–450 English words.
- Complex poster, infographic, interface, or dense scene: up to about 600 words when the additional detail is spatially useful.
- Already detailed request: preserve it and add only missing spatial, material, lighting, or coherence information. Do not inflate it mechanically.

Use present-tense observational prose. Prefer precise modified colors and materials over bare labels. Avoid hedging when the user fixed a detail; use reasonable, coherent choices only for open details.

## Supported default resolutions

| Ratio | Width × height |
|---|---:|
| `1:1` | 1440 × 1440 |
| `3:2` | 1728 × 1152 |
| `2:3` | 1152 × 1728 |
| `4:3` | 1664 × 1248 |
| `3:4` | 1248 × 1664 |
| `5:4` | 1600 × 1280 |
| `4:5` | 1280 × 1600 |
| `16:10` | 1792 × 1120 |
| `10:16` | 1120 × 1792 |
| `16:9` | 1920 × 1080 |
| `9:16` | 1080 × 1920 |
| `2:1` | 2048 × 1024 |
| `1:2` | 1024 × 2048 |
| `21:9` | 2016 × 864 |
| `9:21` | 864 × 2016 |
| `3:1` | 2040 × 680 |
| `1:3` | 680 × 2040 |

Qwen-Image-2.1's VAE samples on a 16-pixel grid. The helper pads a requested size upward to that grid and center-crops the decoded image back to the exact dimensions in this table; for example, 1920 × 1080 is sampled at 1920 × 1088 and cropped by four pixels at the top and bottom.

