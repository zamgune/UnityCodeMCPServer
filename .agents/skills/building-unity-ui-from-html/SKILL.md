---
name: building-unity-ui-from-html
description: >-
  Converts an HTML/CSS UI prototype into a faithful Unity uGUI implementation.
  Provides the complete workflow: extracting design tokens and layout structure
  from the HTML/CSS, mapping CSS layout (grid/flex/absolute) to RectTransforms
  and LayoutGroups, building the hierarchy in chunks via C# script execution,
  and verifying the result with numeric rect dumps and Game View screenshots
  until it matches the prototype. Use when asked to implement, port, or
  recreate a UI design that was delivered as an HTML file (web prototype,
  mockup, AI-generated layout) inside the Unity Editor.
---

# Building Unity UI from HTML Prototypes

Skill for faithfully reproducing an HTML/CSS UI mockup as Unity uGUI using the
Unity Code MCP tools. The reason naive conversions fail is that CSS layout is
translated to RectTransforms from memory and the result is never checked.
This skill replaces that with a measurable spec and a verify loop.

For the CSS-to-uGUI translation table see `references/css-to-ugui-mapping.md`.
For ready-to-run verification and helper scripts see `references/verification-snippets.md`.

## Prerequisites

- Tools: `execute_csharp_script_in_unity_editor`, `get_unity_game_view_window_screenshot`, `read_unity_console_logs`, `get_unity_info`.
- Run `get_unity_info` first and confirm the script execution assemblies
  include ALL of: `UnityEngine.UI`, `Unity.TextMeshPro`, `UnityEngine.UIModule`,
  `UnityEngine.TextRenderingModule`. The module assemblies are required because
  `Canvas`, `RenderMode` and `TextAnchor` are type-forwarded to them — without
  them every UI build script fails with CS1069. If missing, ask the user to add
  them in **Tools > UnityCodeMcpServer > Show or Create Settings**.
- All text must use TextMeshProUGUI. If the prototype contains non-Latin text
  (e.g. Korean), verify a capable TMP font asset exists (snippet C); missing
  glyphs render as squares and no amount of layout work fixes that.

## Workflow

### Phase 0 — Extract a spec from the HTML (do this before touching Unity)

Read the HTML file and produce, in your working notes:

1. **Scope** — identify the mock viewport wrapper (e.g. a `.screen` div that
   only simulates the game screen) versus the actual deliverable (e.g.
   `.shop-popup`). Build only the deliverable; confirm scope with the user if
   ambiguous.
2. **Design resolution** — the prototype's design size (e.g. the wrapper's
   `width/height`, or the viewport the author targeted). This becomes the
   CanvasScaler reference resolution and the Game View size. CSS `px` maps
   1:1 to canvas units at this resolution — never invent scale factors.
3. **Design tokens** — copy every `:root` CSS variable into a token table
   (name, hex value, where it is used). Use these exact values; do not
   eyeball colors from a rendering.
4. **Element tree** — outline each node with: layout system (grid / flex /
   block / absolute), explicit sizes, padding, gap, border, background, and
   typography. This table, not the raw HTML, is what you implement.
5. **Behavior contract** — from the `<script>` block: element ids that get
   updated (→ serialized fields), event handlers (→ Button/Toggle wiring),
   and state rules such as disabled conditions (→ `interactable` logic).
6. **Media queries** — ignore them. Target the single design resolution;
   CanvasScaler handles moderate scaling. Mention responsive variants to the
   user as out of scope unless they ask.

### Phase 1 — Scaffold

- Work in a dedicated scene (e.g. `Assets/Scenes/UIDev_<Name>.unity`) so game
  scenes are never disturbed. Create it via script if missing.
- Before creating a Canvas, search the project for existing UI prefabs or
  canvases and reuse their CanvasScaler settings if the project has a
  convention. Otherwise: Screen Space Overlay, ScaleWithScreenSize,
  referenceResolution = design resolution, matchWidthOrHeight 0.5.
- Ensure an EventSystem exists (buttons silently do nothing without it).
- Set the Game View to the design resolution (snippet B) so screenshots are
  comparable to the prototype.

### Phase 2 — Build in chunks

Build one region at a time (header → body → footer), verifying each chunk
before the next. One giant build script that fails layout review is much more
expensive to debug than three small ones.

- Follow `references/css-to-ugui-mapping.md` for every CSS construct. The two
  highest-frequency mistakes it prevents: CSS borders (uGUI has none — use the
  bordered-panel pattern, snippet D) and CSS grid/flex (use LayoutGroups and
  let Unity compute positions like a browser would, instead of hand-placing).
- Name every GameObject after the HTML class or id it implements
  (`PopupHeader`, `WalletBadge`, `CloseButton`). This keeps later diffs and
  the controller wiring traceable.
- Set colors from the token table only.

### Phase 3 — Verify numerically

After each chunk:

1. `Canvas.ForceUpdateCanvases()` then `LayoutRebuilder.ForceRebuildLayoutImmediate`
   on the root (a freshly created canvas has not done a layout pass yet — without
   the canvas update, LayoutGroups report children at (0,0) with default sizes).
2. Run the rect-dump snippet (snippet A) to get every element's resolved
   position and size.
3. Compare against the spec from Phase 0 (you know the expected boxes from
   the CSS paddings, gaps and fixed sizes). Fix the largest discrepancy
   first, re-dump, repeat. Numbers catch what screenshots hide.

### Phase 4 — Verify visually

- Take `get_unity_game_view_window_screenshot` and compare it against the
  prototype (open the HTML in a browser if you have one available, otherwise
  compare against the Phase 0 spec).
- Check specifically: spacing rhythm, border weights, font sizes relative to
  containers, color fidelity, alignment of text baselines.
- Two or three fix-and-rescreenshot rounds per chunk is normal; more than
  that means the Phase 0 spec was too vague — go back and tighten it.

### Phase 5 — Finalize

- Save the result as a prefab (`Assets/.../UI/<Name>.prefab`) and save the scene.
- Generate a controller MonoBehaviour mirroring the JS contract: one
  `[SerializeField]` per dynamic element id, one method per JS function,
  `onClick` wiring matching the JS listeners. Keep game-logic stubs (`// TODO`)
  where the prototype used fake state.
- Report to the user: what was built, where, and every deliberate deviation
  from the prototype (e.g. shadows approximated, media queries skipped).

## Critical rules

- CSS `px` == canvas units at the reference resolution. 1:1, always.
- Never stack a ContentSizeFitter and a LayoutGroup-controlled child on the
  same RectTransform; use LayoutElement preferred sizes inside LayoutGroups.
- Rebuild layout before measuring; Unity computes LayoutGroups lazily.
- TMP has no numeric font weights: weight ≥ 600 → Bold, else Regular (unless
  the project font has weight variants).
- uGUI Image without a sprite is a flat color rectangle — exactly right for
  flat-design prototypes; only reach for sliced sprites when the CSS has
  `border-radius`.
- Compile errors from generated controller scripts block all tools — fix them
  immediately using `read_unity_console_logs` before continuing.

## Common pitfalls

- Building the mock viewport wrapper as part of the UI (it is scenery, not UI).
- Forgetting the EventSystem, then "fixing" non-clicking buttons by rewriting them.
- Translating `display:flex; justify-content:space-between` as two hand-placed
  children — anchor one left, one right, or use a spacer with flexibleWidth.
- Hand-positioning grid items that a GridLayoutGroup would place correctly.
- Setting `sizeDelta` on an element whose parent LayoutGroup controls it
  (the value is silently overridden — use LayoutElement instead).
- Using default font for Korean/CJK text and shipping squares.
