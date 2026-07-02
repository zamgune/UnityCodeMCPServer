# CSS → uGUI Mapping Reference

Translation table for implementing CSS constructs with Unity uGUI components.
`px` values transfer 1:1 to canvas units at the CanvasScaler reference resolution.

## Layout containers

| CSS | uGUI |
|---|---|
| `display: grid; grid-template-columns: repeat(N, Wpx); gap: G; padding: P` | `GridLayoutGroup`: cellSize (W, H from row height or aspect-ratio), spacing (G, G), padding P, constraint FixedColumnCount = N |
| `display: grid; grid-template-rows: auto 1fr auto` (header/body/footer) | Prefer anchors for fixed-size panels: header anchored top-stretch with fixed height, footer bottom-stretch, body stretch between (offsets = header/footer heights). Use `VerticalLayoutGroup` + middle child `LayoutElement.flexibleHeight = 1` only when heights are content-driven |
| `display: grid; grid-template-columns: 1fr auto auto` | `HorizontalLayoutGroup` (controlChild W+H on, forceExpand off) with first child `LayoutElement.flexibleWidth = 1`, others `preferredWidth` |
| `display: flex; gap: G` (row) | `HorizontalLayoutGroup`: spacing G, childControlWidth/Height true, childForceExpand false |
| `display: flex; flex-direction: column` | `VerticalLayoutGroup`, same settings |
| `justify-content: space-between` (two items) | Anchor first child left, second right — no LayoutGroup needed |
| `justify-content: space-between` (3+ items) | `HorizontalLayoutGroup` + empty spacer GameObjects with `LayoutElement.flexibleWidth = 1` between items |
| `justify-content: center` / `place-items: center` | LayoutGroup `childAlignment = Middle/Center`, or child anchored to center with pivot (0.5, 0.5) |
| `align-items: center` | LayoutGroup childAlignment Middle row |
| `flex-wrap: wrap` | No direct equivalent — `GridLayoutGroup` with flexible constraint, or fixed layout per design resolution |
| `position: absolute; inset: 0` | anchorMin (0,0), anchorMax (1,1), offsetMin/Max = 0 |
| `position: absolute; top: T; right: R` | anchor (1,1), pivot (1,1), anchoredPosition (-R, -T) |
| `overflow: auto` | ScrollRect template below |
| `aspect-ratio: 1 / 1` | `AspectRatioFitter` (FitInParent / WidthControlsHeight), or GridLayoutGroup square cellSize |

## Box model

| CSS | uGUI |
|---|---|
| `width/height: Npx` | `sizeDelta` when free; `LayoutElement.preferredWidth/Height = N` when under a LayoutGroup |
| `min-height: Npx` | `LayoutElement.minHeight = N` |
| `max-height: calc(100vh - X)` | Anchored stretch with offset X; or ignore when the design resolution makes it moot |
| `padding` | LayoutGroup `padding` (RectOffset); for non-LayoutGroup panels, inset the child rect |
| `margin` | uGUI has no margins — convert to parent padding/spacing, or spacer elements |
| `gap: G` | LayoutGroup `spacing = G` |
| `border: Npx solid C` | **No border property exists.** Bordered-panel pattern: parent `Image` (color C) + child fill `Image` inset by N on all sides (anchors stretch, offsets ±N). See snippet D |
| `border-bottom: Npx solid C` (divider) | Thin child `Image`: anchored bottom-stretch, height N, color C |
| `background: <color>` | `Image.color` (no sprite needed for flat fills) |
| `background: linear-gradient(...)` | Approximate with the dominant flat color, or note as deviation; gradients need a generated sprite/shader |
| `border-radius` | Sliced sprite with rounded corners required; for prototypes confirm whether square corners are acceptable |
| `box-shadow: X Y B rgba(...)` | `Shadow` component: effectColor = rgba, effectDistance = (X, -Y). Blur is not supported — approximate and report as deviation |

## Typography (always TextMeshProUGUI)

| CSS | TMP |
|---|---|
| `font-size: Npx` | `fontSize = N` |
| `font-weight: ≥600` | `fontStyle = FontStyles.Bold` (TMP has no numeric weights without font variants) |
| `color` | `color` from token table |
| `text-align: center` | `alignment = TextAlignmentOptions.Center` |
| `line-height: 1.45` | line height ≈ fontSize × 1.45; TMP `lineSpacing` is an offset — adjust visually, note as approximation |
| `letter-spacing` | `characterSpacing` (TMP uses font units; tune visually) |
| `white-space: nowrap` | `textWrappingMode = TextWrappingModes.NoWrap` (older TMP: `enableWordWrapping = false`) |
| `text-overflow: ellipsis` | `overflowMode = TextOverflowModes.Ellipsis` |

## Interactive elements

| HTML/CSS | uGUI |
|---|---|
| `<button>` | `Button` + target `Image`; child TMP label (+ icon children as in markup) |
| `button:disabled { background; color }` | `Button.interactable = false`; put the CSS disabled colors into `ColorBlock.disabledColor` (note: tints multiply the target Image color) |
| `:hover` | `ColorBlock.highlightedColor` |
| `[aria-pressed="true"]` / selected state | `Toggle` with ToggleGroup for exclusive lists; or manual selected-color swap in the controller (matches typical JS `render()` logic better) |
| `<input type="text">` | `TMP_InputField` |
| Checkbox / radio | `Toggle` (+ ToggleGroup) |

## ScrollRect template (`overflow: auto`)

```
ScrollView (Image bg, ScrollRect: vertical only for overflow-y)
└─ Viewport (RectMask2D, anchors stretch)
   └─ Content (VerticalLayoutGroup + ContentSizeFitter verticalFit=Preferred,
               anchored top-stretch, pivot (0.5, 1))
```

ScrollRect.content = Content, viewport = Viewport. Children of Content use
LayoutElement, never manual positions.

## Canvas setup

| Prototype | Unity |
|---|---|
| Design viewport W×H | CanvasScaler: ScaleWithScreenSize, referenceResolution (W, H), matchWidthOrHeight 0.5 |
| `@media` rules | Ignore — single design resolution; report responsive variants as out of scope |
| Centered popup over dimmed screen | Full-screen `Image` (overlay rgba) + popup child anchored center, fixed size |
