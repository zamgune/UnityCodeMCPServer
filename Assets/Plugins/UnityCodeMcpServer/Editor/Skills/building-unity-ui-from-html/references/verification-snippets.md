# Verification & Helper Snippets

Ready-to-run scripts for `execute_csharp_script_in_unity_editor`. They assume
`UnityEngine.UI` and `Unity.TextMeshPro` are in the script execution assemblies.

## A — Rect dump (the "DOM inspector")

Dumps the resolved layout of every RectTransform under a root. Run after every
build chunk and compare the numbers against the CSS spec.

```csharp
var root = UnityEngine.GameObject.Find("ShopPopup"); // root GameObject name
if (root == null) return "root not found";
var rootRect = root.GetComponent<UnityEngine.RectTransform>();
// ForceUpdateCanvases first: freshly created canvases have not done a layout
// pass yet, and without it LayoutGroups report children at (0,0) default sizes.
UnityEngine.Canvas.ForceUpdateCanvases();
UnityEngine.UI.LayoutRebuilder.ForceRebuildLayoutImmediate(rootRect);
var sb = new System.Text.StringBuilder();
void Dump(UnityEngine.RectTransform rt, int depth)
{
    var r = rt.rect;
    var p = rt.anchoredPosition;
    sb.AppendLine($"{new string(' ', depth * 2)}{rt.name}  pos=({p.x:F0},{p.y:F0}) size=({r.width:F0}x{r.height:F0})");
    foreach (UnityEngine.Transform c in rt)
        if (c is UnityEngine.RectTransform crt) Dump(crt, depth + 1);
}
Dump(rootRect, 0);
return sb.ToString();
```

## B — Set Game View to the design resolution

Makes screenshots comparable to the prototype (Unity 2022.2+).

```csharp
UnityEditor.PlayModeWindow.SetCustomRenderingResolution(1040, 680, "UIProto");
return "game view set";
```

## C — Find a TMP font asset that supports the prototype's language

```csharp
var sb = new System.Text.StringBuilder();
char probe = '상'; // a character from the prototype's text
foreach (string guid in UnityEditor.AssetDatabase.FindAssets("t:TMP_FontAsset"))
{
    string path = UnityEditor.AssetDatabase.GUIDToAssetPath(guid);
    var font = UnityEditor.AssetDatabase.LoadAssetAtPath<TMPro.TMP_FontAsset>(path);
    if (font != null)
        sb.AppendLine($"{path} supports'{probe}'={font.HasCharacter(probe)}");
}
return sb.Length == 0 ? "no TMP font assets in project" : sb.ToString();
```

If no font supports the language, stop and tell the user to import one (e.g.
a Noto Sans font asset) — squares in screenshots are a font problem, not layout.

## D — Bordered panel helper (CSS `border: Npx solid C`)

uGUI has no borders. Create border-color parent + inset fill child:

```csharp
UnityEngine.GameObject MakeBorderedPanel(string name, UnityEngine.Transform parent,
    UnityEngine.Color borderColor, UnityEngine.Color fillColor, float borderWidth)
{
    var panel = new UnityEngine.GameObject(name, typeof(UnityEngine.RectTransform), typeof(UnityEngine.UI.Image));
    panel.transform.SetParent(parent, false);
    panel.GetComponent<UnityEngine.UI.Image>().color = borderColor;

    var fill = new UnityEngine.GameObject("Fill", typeof(UnityEngine.RectTransform), typeof(UnityEngine.UI.Image));
    fill.transform.SetParent(panel.transform, false);
    var rt = fill.GetComponent<UnityEngine.RectTransform>();
    rt.anchorMin = UnityEngine.Vector2.zero;
    rt.anchorMax = UnityEngine.Vector2.one;
    rt.offsetMin = new UnityEngine.Vector2(borderWidth, borderWidth);
    rt.offsetMax = new UnityEngine.Vector2(-borderWidth, -borderWidth);
    fill.GetComponent<UnityEngine.UI.Image>().color = fillColor;
    return panel; // put content under Fill, not panel
}
```

Content goes under `Fill`. When the panel sits in a LayoutGroup, add the
LayoutElement to `panel`; when the panel itself needs a LayoutGroup for its
content, put it on `Fill`.

## E — Scene scaffold (dedicated UI dev scene + canvas + EventSystem)

**Warning:** `NewSceneMode.Single` closes the currently open scene. Check
`EditorSceneManager.GetActiveScene().isDirty` first and ask the user before
discarding unsaved work, or use `NewSceneMode.Additive` and close your scene
when done.

```csharp
var scene = UnityEditor.SceneManagement.EditorSceneManager.NewScene(
    UnityEditor.SceneManagement.NewSceneSetup.EmptyScene,
    UnityEditor.SceneManagement.NewSceneMode.Single);

var canvasGo = new UnityEngine.GameObject("Canvas",
    typeof(UnityEngine.Canvas), typeof(UnityEngine.UI.CanvasScaler), typeof(UnityEngine.UI.GraphicRaycaster));
canvasGo.GetComponent<UnityEngine.Canvas>().renderMode = UnityEngine.RenderMode.ScreenSpaceOverlay;
var scaler = canvasGo.GetComponent<UnityEngine.UI.CanvasScaler>();
scaler.uiScaleMode = UnityEngine.UI.CanvasScaler.ScaleMode.ScaleWithScreenSize;
scaler.referenceResolution = new UnityEngine.Vector2(1040, 680); // design resolution
scaler.matchWidthOrHeight = 0.5f;

new UnityEngine.GameObject("EventSystem",
    typeof(UnityEngine.EventSystems.EventSystem),
    typeof(UnityEngine.EventSystems.StandaloneInputModule));

UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene, "Assets/Scenes/UIDev_ShopPopup.unity");
return "scaffolded";
```

For projects on the new Input System, replace `StandaloneInputModule` with
`UnityEngine.InputSystem.UI.InputSystemUIInputModule` (assembly
`Unity.InputSystem`).

## Screenshot

Use the dedicated `get_unity_game_view_window_screenshot` tool — it returns the
Game View image; with snippet B applied its resolution matches the prototype.
Compare deliberately: spacing rhythm, border weights, font sizes, exact colors.
