# Demo asset: `cc-htmlfeedback-demo.webp`

Autoplaying demo shown at the top of the repo README. Built from `area.mp4`
(1008x720, 60fps, 31s, 2.5MB screen recording).

## Why animated WebP (not MP4)

GitHub **strips `autoplay` from `<video>` tags**, so an mp4 only ever shows a
click-to-play player. Animated images referenced with `<img>` autoplay and loop
and can't be blocked - so the source mp4 is transcoded to an animated `.webp`.

## Regenerate

```bash
ffmpeg -y -i area.mp4 \
  -vf "fps=5,scale=720:-1:flags=lanczos" \
  -loop 0 -c:v libwebp -lossless 0 -quality 30 \
  -compression_level 6 -method 6 \
  docs/media/cc-htmlfeedback-demo.webp
```

Result: 720x514, 5fps, loop forever, ~2.3MB.

## Sizing notes (what actually moves the needle)

The clip is a continuous **zoom/pan screencast** (~148 scene changes over 31s),
so nearly every frame differs. Consequences:

- **Frame count dominates size, not quality.** Cutting fps and resolution is the
  only effective lever; lossy `-quality` has a smaller effect than expected.
- **Don't route through GIF.** `ffmpeg -> gif -> gif2webp` looked promising (webp
  frame-diffing) but the GIF's 256-color dithering injects noise that *inflates*
  the webp and softens text. Direct `mp4 -> libwebp` is cleaner and smaller here.
- **ffmpeg's libwebp writes full-canvas keyframes** (no inter-frame diffing), but
  that barely matters for this clip since the content changes constantly anyway.

### Measured tradeoff curve

| fps | width | quality | size   |
|-----|-------|---------|--------|
| 30  | 1008  | 55      | 26 MB  |
| 10  | 840   | 40      | 5.4 MB |
| 6   | 820   | 36      | 3.6 MB |
| 5   | 720   | 30      | 2.3 MB | ← shipped |

Lower than ~2MB means dropping below 5fps (choppy) or below ~720px (text softens).
5fps/720px keeps the on-page document text readable, and it's crisper still during
the video's zoom-ins.
