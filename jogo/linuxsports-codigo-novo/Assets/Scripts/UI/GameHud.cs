// HUD e menus em uGUI sobre os layouts NW4R. Os layouts originais (Nw4rLayoutLibrary) ficam numa camada de
// fundo; textos dinâmicos vão nos painéis T_* do layout quando existem e sempre numa camada de texto
// própria (fonte embutida), para o placar ficar legível mesmo com painel ausente.
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace LinuxSports.UI
{
    public sealed class GameHud : MonoBehaviour
    {
        public static GameHud Instance { get; private set; }

        public Canvas Canvas { get; private set; }
        public RectTransform LayoutLayer { get; private set; }
        public RectTransform TextLayer { get; private set; }
        public Font Font { get; private set; }

        private Text score, message, hint, title;
        private Image meterBack, meterFill, fade;
        private float messageUntil;
        private float fadeTarget, fadeValue;
        private readonly Dictionary<string, Nw4rLayout> layouts = new Dictionary<string, Nw4rLayout>();

        public static GameHud Ensure()
        {
            if (Instance != null) return Instance;
            var go = new GameObject("[GameHud]");
            DontDestroyOnLoad(go);
            return go.AddComponent<GameHud>();
        }

        private void Awake()
        {
            Instance = this;
            Canvas = gameObject.AddComponent<Canvas>();
            Canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            Canvas.sortingOrder = 100;
            var scaler = gameObject.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1280f, 720f);
            scaler.matchWidthOrHeight = 0.5f;
            gameObject.AddComponent<GraphicRaycaster>();
            Font = LoadFont();
            LayoutLayer = Layer("Layouts");
            // Os layouts NW4R são de 608x456 (4:3); escala para caber na altura de referência.
            LayoutLayer.localScale = Vector3.one * (720f / 456f);
            TextLayer = Layer("Text");
            title = MakeText("Title", TextAnchor.UpperCenter, 46, new Vector2(0.5f, 1f), new Vector2(0f, -40f), new Vector2(1100f, 80f));
            score = MakeText("Score", TextAnchor.UpperLeft, 26, new Vector2(0f, 1f), new Vector2(24f, -20f), new Vector2(900f, 240f));
            message = MakeText("Message", TextAnchor.MiddleCenter, 54, new Vector2(0.5f, 0.5f), new Vector2(0f, 80f), new Vector2(1200f, 160f));
            hint = MakeText("Hint", TextAnchor.LowerCenter, 22, new Vector2(0.5f, 0f), new Vector2(0f, 24f), new Vector2(1200f, 90f));
            meterBack = MakeImage("MeterBack", new Color(0f, 0f, 0f, 0.55f), new Vector2(1f, 0f), new Vector2(-60f, 140f), new Vector2(34f, 360f));
            meterFill = MakeImage("MeterFill", new Color(1f, 0.75f, 0.1f, 0.95f), new Vector2(1f, 0f), new Vector2(-60f, 140f), new Vector2(26f, 352f));
            meterFill.rectTransform.pivot = new Vector2(0.5f, 0f);
            meterFill.rectTransform.anchoredPosition = new Vector2(-60f, 144f);
            SetMeter(0f, false);
            fade = MakeImage("Fade", Color.black, new Vector2(0.5f, 0.5f), Vector2.zero, Vector2.zero);
            fade.rectTransform.anchorMin = Vector2.zero;
            fade.rectTransform.anchorMax = Vector2.one;
            fade.rectTransform.sizeDelta = Vector2.zero;
            fade.raycastTarget = false;
            fade.color = new Color(0f, 0f, 0f, 0f);
        }

        public static Font LoadFont()
        {
            Font f = null;
            try { f = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf"); } catch (Exception) { f = null; }
            if (f == null) { try { f = Resources.GetBuiltinResource<Font>("Arial.ttf"); } catch (Exception) { f = null; } }
            return f;
        }

        private RectTransform Layer(string n)
        {
            var go = new GameObject(n, typeof(RectTransform));
            var rt = (RectTransform)go.transform;
            rt.SetParent(transform, false);
            rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0.5f, 0.5f);
            rt.sizeDelta = new Vector2(1280f, 720f);
            return rt;
        }

        public Text MakeText(string n, TextAnchor align, int size, Vector2 anchor, Vector2 pos, Vector2 box, RectTransform parent = null)
        {
            var go = new GameObject(n, typeof(RectTransform));
            var rt = (RectTransform)go.transform;
            rt.SetParent(parent != null ? parent : (RectTransform)transform, false);
            rt.anchorMin = rt.anchorMax = anchor;
            rt.pivot = anchor;
            rt.anchoredPosition = pos;
            rt.sizeDelta = box;
            var t = go.AddComponent<Text>();
            t.font = Font;
            t.fontSize = size;
            t.alignment = align;
            t.color = Color.white;
            t.horizontalOverflow = HorizontalWrapMode.Wrap;
            t.verticalOverflow = VerticalWrapMode.Overflow;
            t.raycastTarget = false;
            var sh = go.AddComponent<Outline>();
            sh.effectColor = new Color(0f, 0f, 0f, 0.85f);
            sh.effectDistance = new Vector2(2f, -2f);
            return t;
        }

        private Image MakeImage(string n, Color c, Vector2 anchor, Vector2 pos, Vector2 size)
        {
            var go = new GameObject(n, typeof(RectTransform));
            var rt = (RectTransform)go.transform;
            rt.SetParent(transform, false);
            rt.anchorMin = rt.anchorMax = anchor;
            rt.pivot = new Vector2(0.5f, 0f);
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;
            var img = go.AddComponent<Image>();
            img.color = c;
            img.raycastTarget = false;
            return img;
        }

        private void Update()
        {
            if (message.text.Length > 0 && Time.unscaledTime > messageUntil) message.text = "";
            if (!Mathf.Approximately(fadeValue, fadeTarget))
            {
                fadeValue = Mathf.MoveTowards(fadeValue, fadeTarget, Time.unscaledDeltaTime * 3f);
                fade.color = new Color(0f, 0f, 0f, fadeValue);
            }
        }

        public void SetTitle(string t) { title.text = t ?? ""; }
        public void SetScore(string t) { score.text = t ?? ""; }
        public void SetHint(string t) { hint.text = t ?? ""; }
        public void ShowMessage(string t, float seconds = 2f) { message.text = t ?? ""; messageUntil = Time.unscaledTime + seconds; }
        public void ClearMessage() { message.text = ""; }
        public void Fade(bool toBlack) { fadeTarget = toBlack ? 1f : 0f; }
        public bool FadeDone => Mathf.Approximately(fadeValue, fadeTarget);

        public void SetMeter(float value01, bool visible, Color? color = null)
        {
            meterBack.enabled = meterFill.enabled = visible;
            meterFill.rectTransform.sizeDelta = new Vector2(26f, 352f * Mathf.Clamp01(value01));
            if (color.HasValue) meterFill.color = color.Value;
        }

        public void ClearAll()
        {
            SetTitle(""); SetScore(""); SetHint(""); ClearMessage(); SetMeter(0f, false);
            ClearLayouts();
        }

        // ------------------------------------------------------------------ layouts NW4R
        /// <summary>Mostra um layout (assetId ou nome) e toca a animação de entrada se houver.</summary>
        public void ShowLayout(string id, Action<Nw4rLayout> onReady = null, string inAnimation = null)
        {
            if (string.IsNullOrEmpty(id)) { if (onReady != null) onReady(null); return; }
            Nw4rLayout existing;
            if (layouts.TryGetValue(id, out existing) && existing != null) { if (onReady != null) onReady(existing); return; }
            layouts[id] = null;
            Nw4rLayoutLibrary.Instance.Create(id, LayoutLayer, lay =>
            {
                if (lay == null) { layouts.Remove(id); if (onReady != null) onReady(null); return; }
                if (!layouts.ContainsKey(id)) { Destroy(lay.gameObject); return; }    // removido enquanto carregava
                layouts[id] = lay;
                string anim = inAnimation;
                if (anim == null)
                    foreach (var a in Nw4rLayoutLibrary.Instance.AnimationsOf(id))
                        if (a.Contains("_in_") || a.Contains("_inFrame_") || a.Contains("_inoutScene_")) { anim = a; break; }
                if (anim != null) Nw4rLayoutLibrary.Instance.PlayAnimation(lay, anim, false);
                if (onReady != null) onReady(lay);
            });
        }

        public Nw4rLayout Layout(string id) { Nw4rLayout l; return id != null && layouts.TryGetValue(id, out l) ? l : null; }

        /// <summary>Escreve num painel de texto do layout, se ele existir (painéis ausentes são ignorados).</summary>
        public bool SetPane(string layoutId, string pane, string text)
        {
            var l = Layout(layoutId);
            return l != null && l.SetText(pane, text);
        }

        public void HideLayout(string id)
        {
            Nw4rLayout l;
            if (id != null && layouts.TryGetValue(id, out l))
            {
                if (l != null) Destroy(l.gameObject);
                layouts.Remove(id);
            }
        }

        public void ClearLayouts()
        {
            foreach (var kv in layouts) if (kv.Value != null) Destroy(kv.Value.gameObject);
            layouts.Clear();
        }

        public void ShowLayouts(IEnumerable<string> ids)
        {
            if (ids == null) return;
            foreach (var id in ids) ShowLayout(id);
        }
    }
}
