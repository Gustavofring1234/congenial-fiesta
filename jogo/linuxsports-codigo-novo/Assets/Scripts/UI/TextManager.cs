// Textos do jogo para a UI, por arquivo + id.
//
// Fontes (StreamingAssets/Text/text_index.json, gerado por tools/stage_unity_assets.py):
//   bmg: extração completa dos .bmg (tools/bmg_extract.py): <idioma>/common_message.text.json e
//        sports_message.text.json. Cada mensagem: id (MID1, único por arquivo), index (INF1), text com
//        {0}, {1}... (args: 'value' número/texto, 'name' nome do Mii) e controls (tags de janela/cor).
//   tsv: exportação parcial antiga (raw/docs/textos/*.tsv, colunas indice/texto). Usada só como
//        reserva para índices que faltarem no .bmg (os TSV têm tags desalinhadas).
// Os ids se repetem entre arquivos, então toda busca leva o arquivo.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.UI
{
    public sealed class TextMessage
    {
        public int id, index;
        public string text;
        public string[] args;
    }

    public sealed class TextManager
    {
        public const string IndexPath = "Text/text_index.json";
        public const string CommonFile = "common_message";
        public const string SportsFile = "sports_message";

        private static TextManager current;
        public static TextManager Current => current;
        public static bool IsLoaded => current != null;
        public static event Action<TextManager> OnLoaded;

        public string Language { get; private set; }
        private readonly Dictionary<string, Dictionary<int, TextMessage>> byId = new Dictionary<string, Dictionary<int, TextMessage>>();
        private readonly Dictionary<string, List<TextMessage>> byIndex = new Dictionary<string, List<TextMessage>>();
        private readonly Dictionary<string, Dictionary<int, string>> tsv = new Dictionary<string, Dictionary<int, string>>();

        /// <summary>Carrega todos os arquivos de um idioma (assíncrono, via UnityWebRequest).</summary>
        public static void Load(string language, Action<TextManager> onDone, Action<string> onError = null)
        {
            var loader = StreamingAssetLoader.Instance;
            loader.LoadJson(IndexPath, idx =>
            {
                var tm = new TextManager { Language = language };
                var paths = new List<string>();
                foreach (var e in J.Objs(idx, "bmg")) if (J.Str(e, "language") == language) paths.Add(J.Str(e, "path"));
                var tsvEntries = new List<Dictionary<string, object>>(J.Objs(idx, "tsv"));
                if (paths.Count == 0)
                {
                    string msg = "TextManager: nenhum texto para o idioma '" + language + "'";
                    if (onError != null) onError(msg); else Debug.LogError(msg);
                    return;
                }
                loader.LoadAllJson(paths, docs =>
                {
                    foreach (var kv in docs) tm.Add(kv.Value);
                    int left = tsvEntries.Count;
                    Action finish = () =>
                    {
                        current = tm;
                        onDone?.Invoke(tm);
                        OnLoaded?.Invoke(tm);
                    };
                    if (left == 0) { finish(); return; }
                    foreach (var t in tsvEntries)
                    {
                        string file = J.Str(t, "file");
                        loader.LoadText(J.Str(t, "path"), text => { tm.AddTsv(file, text); if (--left == 0) finish(); },
                                        err => { Debug.LogWarning(err); if (--left == 0) finish(); });
                    }
                });
            }, onError);
        }

        /// <summary>Acrescenta um documento 'nw4r-text' (útil também em testes).</summary>
        public void Add(object doc)
        {
            string file = J.Str(doc, "file");
            if (file == null) return;
            var ids = new Dictionary<int, TextMessage>();
            var list = new List<TextMessage>();
            foreach (var m in J.Objs(doc, "messages"))
            {
                var msg = new TextMessage
                {
                    id = J.Int(m, "id"), index = J.Int(m, "index"), text = J.Str(m, "text", ""),
                    args = J.Strings(m, "args").ToArray(),
                };
                ids[msg.id] = msg;
                list.Add(msg);
            }
            byId[file] = ids;
            byIndex[file] = list;
        }

        public void AddTsv(string file, string text)
        {
            var d = new Dictionary<int, string>();
            var lines = text.Split('\n');
            for (int i = 1; i < lines.Length; i++)
            {
                string line = lines[i].TrimEnd('\r');
                int tab = line.IndexOf('\t');
                int n;
                if (tab <= 0 || !int.TryParse(line.Substring(0, tab), NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) continue;
                d[n] = line.Substring(tab + 1).Replace("\\n", "\n");
            }
            tsv[file] = d;
        }

        /// <summary>Aceita 0x3e700, "0x3e700" ou "255744".</summary>
        public static int ParseId(string id)
        {
            id = id.Trim();
            if (id.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                return int.Parse(id.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return int.Parse(id, NumberStyles.Integer, CultureInfo.InvariantCulture);
        }

        public TextMessage Get(string file, int id)
        {
            Dictionary<int, TextMessage> d;
            TextMessage m;
            return byId.TryGetValue(file, out d) && d.TryGetValue(id, out m) ? m : null;
        }

        public TextMessage ByIndex(string file, int index)
        {
            List<TextMessage> l;
            return byIndex.TryGetValue(file, out l) && index >= 0 && index < l.Count ? l[index] : null;
        }

        /// <summary>Texto bruto por índice, com reserva no TSV.</summary>
        public string TextByIndex(string file, int index)
        {
            var m = ByIndex(file, index);
            if (m != null && !string.IsNullOrEmpty(m.text)) return m.text;
            Dictionary<int, string> d;
            string s;
            return tsv.TryGetValue(file, out d) && d.TryGetValue(index, out s) ? s : null;
        }

        /// <summary>Texto com {n} trocados pelos argumentos. Id inexistente vira "[arquivo#0x...]" (visível, sem quebrar a tela).</summary>
        public string Format(string file, int id, params object[] args)
        {
            var m = Get(file, id);
            if (m == null) return "[" + file + "#0x" + id.ToString("x", CultureInfo.InvariantCulture) + "]";
            return Substitute(m.text, args);
        }

        public string Format(string file, string id, params object[] args) { return Format(file, ParseId(id), args); }

        public static string Substitute(string text, object[] args)
        {
            if (string.IsNullOrEmpty(text) || text.IndexOf('{') < 0) return text ?? "";
            var sb = new StringBuilder(text.Length + 16);
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '{')
                {
                    int close = text.IndexOf('}', i + 1);
                    int n;
                    if (close > i && int.TryParse(text.Substring(i + 1, close - i - 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out n))
                    {
                        if (args != null && n < args.Length && args[n] != null) sb.Append(Convert.ToString(args[n], CultureInfo.InvariantCulture));
                        else sb.Append(text, i, close - i + 1);
                        i = close;
                        continue;
                    }
                }
                sb.Append(c);
            }
            return sb.ToString();
        }

        /// <summary>Busca por id (decimal ou 0x...) ou trecho do texto, sem diferenciar caixa.</summary>
        public List<KeyValuePair<string, TextMessage>> Search(string query, string file = null, int limit = 200)
        {
            var r = new List<KeyValuePair<string, TextMessage>>();
            string q = (query ?? "").Trim().ToLowerInvariant();
            int asId = -1;
            try { if (q.Length > 0 && (q.StartsWith("0x") || char.IsDigit(q[0]))) asId = ParseId(q); }
            catch (FormatException) { asId = -1; }
            catch (OverflowException) { asId = -1; }
            foreach (var kv in byIndex)
            {
                if (file != null && kv.Key != file) continue;
                foreach (var m in kv.Value)
                {
                    if (q.Length == 0 || m.id == asId || m.text.ToLowerInvariant().Contains(q))
                    {
                        r.Add(new KeyValuePair<string, TextMessage>(kv.Key, m));
                        if (r.Count >= limit) return r;
                    }
                }
            }
            return r;
        }

        public IEnumerable<string> Files => byIndex.Keys;
    }
}
