// Lista de opções navegável por InputRouter (Move/Confirm/Back: teclado, gamepad, toque, sensores) e por
// ponteiro (passar o mouse/dedo seleciona, clique/toque confirma). Desenhada na camada de texto do GameHud.
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace LinuxSports.UI
{
    public sealed class MenuView : MonoBehaviour
    {
        public sealed class Item
        {
            public string label;
            public Action onSelect;
            public Func<string> dynamicLabel;
            public Action<int> onAdjust;      // esquerda/direita (-1/+1) para opções com valor
            public bool enabled = true;
        }

        private readonly List<Item> items = new List<Item>();
        private readonly List<Text> texts = new List<Text>();
        private RectTransform panel;
        private Image highlight;
        private Text header;
        private int selected;
        private float repeatAt;
        private int lastDir;
        private float lastAdjust;
        private Action onBack;
        private float openedAt;

        public int Selected => selected;
        public bool IsOpen => panel != null && panel.gameObject.activeSelf;

        public static MenuView Create(GameHud hud)
        {
            var go = new GameObject("Menu", typeof(RectTransform));
            go.transform.SetParent(hud.TextLayer, false);
            var m = go.AddComponent<MenuView>();
            m.panel = (RectTransform)go.transform;
            m.panel.anchorMin = m.panel.anchorMax = m.panel.pivot = new Vector2(0.5f, 0.5f);
            m.panel.sizeDelta = new Vector2(760f, 560f);
            var bg = go.AddComponent<Image>();
            bg.color = new Color(0.05f, 0.1f, 0.2f, 0.72f);
            bg.raycastTarget = false;
            var hl = new GameObject("Highlight", typeof(RectTransform));
            hl.transform.SetParent(go.transform, false);
            m.highlight = hl.AddComponent<Image>();
            m.highlight.color = new Color(0.25f, 0.7f, 1f, 0.45f);
            m.highlight.raycastTarget = false;
            m.header = hud.MakeText("Header", TextAnchor.UpperCenter, 34, new Vector2(0.5f, 1f), new Vector2(0f, -16f), new Vector2(740f, 60f), m.panel);
            go.SetActive(false);
            return m;
        }

        public void Open(string title, IList<Item> options, Action back, int initial = 0)
        {
            items.Clear();
            items.AddRange(options);
            onBack = back;
            header.text = title ?? "";
            foreach (var t in texts) Destroy(t.gameObject);
            texts.Clear();
            var hud = GameHud.Instance;
            float rowH = Mathf.Min(54f, 470f / Mathf.Max(1, items.Count));
            int size = Mathf.Clamp(Mathf.RoundToInt(rowH * 0.6f), 16, 30);
            for (int i = 0; i < items.Count; i++)
            {
                var t = hud.MakeText("Item" + i, TextAnchor.MiddleCenter, size, new Vector2(0.5f, 1f), new Vector2(0f, -84f - i * rowH), new Vector2(720f, rowH), panel);
                texts.Add(t);
            }
            selected = Mathf.Clamp(initial, 0, Mathf.Max(0, items.Count - 1));
            while (items.Count > 0 && !items[selected].enabled && selected < items.Count - 1) selected++;
            panel.gameObject.SetActive(true);
            openedAt = Time.unscaledTime;
            Refresh();
        }

        public void Close() { if (panel != null) panel.gameObject.SetActive(false); }

        private void Refresh()
        {
            for (int i = 0; i < items.Count; i++)
            {
                var it = items[i];
                string label = it.dynamicLabel != null ? it.dynamicLabel() : it.label;
                if (it.onAdjust != null) label = "<  " + label + "  >";
                texts[i].text = label;
                texts[i].color = it.enabled ? (i == selected ? Color.white : new Color(0.85f, 0.9f, 1f)) : new Color(0.5f, 0.5f, 0.55f);
            }
            if (items.Count > 0)
            {
                var rt = highlight.rectTransform;
                var tr = texts[selected].rectTransform;
                rt.anchorMin = rt.anchorMax = tr.anchorMin;
                rt.pivot = tr.pivot;
                rt.anchoredPosition = tr.anchoredPosition;
                rt.sizeDelta = new Vector2(730f, tr.sizeDelta.y - 4f);
            }
        }

        private void Update()
        {
            if (!IsOpen || items.Count == 0) return;
            var input = InputRouter.Instance;
            float y = input.Move.y, x = input.Move.x;
            int dir = y > 0.5f ? -1 : y < -0.5f ? 1 : 0;
            if (dir != 0 && (dir != lastDir || Time.unscaledTime >= repeatAt))
            {
                Step(dir);
                repeatAt = Time.unscaledTime + (dir != lastDir ? 0.35f : 0.12f);
            }
            lastDir = dir;
            int adj = x > 0.5f ? 1 : x < -0.5f ? -1 : 0;
            if (adj != 0 && items[selected].onAdjust != null && Time.unscaledTime - lastAdjust > 0.22f)
            {
                lastAdjust = Time.unscaledTime;
                items[selected].onAdjust(adj);
                AudioManager.Instance.PlaySfx(SfxKind.Click, 0.5f);
                Refresh();
            }
            int hover = PointerHover();
            if (hover >= 0 && hover != selected && items[hover].enabled) { selected = hover; Refresh(); }
            if (Time.unscaledTime - openedAt < 0.15f) return;   // evita confirmar com o mesmo clique que abriu
            bool click = hover >= 0 && Pointer.current != null && Pointer.current.press.wasReleasedThisFrame;
            if ((input.ConfirmThisFrame || click) && items[selected].enabled)
            {
                var it = items[selected];
                AudioManager.Instance.Play("SE_TR_Common_Sports_Decide");
                if (it.onSelect != null) it.onSelect();
                else if (it.onAdjust != null) { it.onAdjust(1); Refresh(); }
            }
            else if (input.BackThisFrame && onBack != null)
            {
                AudioManager.Instance.Play("SE_TR_Common_Sports_Cancel");
                onBack();
            }
            else Refresh();
        }

        private void Step(int dir)
        {
            int n = items.Count;
            for (int k = 0; k < n; k++)
            {
                selected = (selected + dir + n) % n;
                if (items[selected].enabled) break;
            }
            AudioManager.Instance.Play("SE_TR_Common_Sports_Cursol", 0.6f);
            Refresh();
        }

        private int PointerHover()
        {
            var p = Pointer.current;
            if (p == null) return -1;
            // Toque só conta enquanto o dedo está na tela.
            if (p is Touchscreen && !p.press.isPressed && !p.press.wasReleasedThisFrame) return -1;
            Vector2 pos = p.position.ReadValue();
            for (int i = 0; i < texts.Count; i++)
                if (RectTransformUtility.RectangleContainsScreenPoint(texts[i].rectTransform, pos, null)) return i;
            return -1;
        }
    }
}
