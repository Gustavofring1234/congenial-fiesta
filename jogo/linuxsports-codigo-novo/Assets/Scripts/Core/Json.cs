// Leitor JSON mínimo, sem reflexão (seguro para IL2CPP/WebGL e sem dependência de pacotes).
// Produz: Dictionary<string, object>, List<object>, double, string, bool e null.
// JsonUtility não serve aqui: os JSON do pipeline têm arrays heterogêneos e objetos com chaves livres.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace LinuxSports.Core
{
    public static class Json
    {
        public static object Parse(string text)
        {
            if (text == null) throw new ArgumentNullException(nameof(text));
            var p = new Parser(text);
            p.SkipWs();
            object v = p.ReadValue();
            p.SkipWs();
            if (!p.End) throw new FormatException("JSON: conteúdo extra na posição " + p.Pos);
            return v;
        }

        public static Dictionary<string, object> ParseObject(string text)
        {
            var o = Parse(text) as Dictionary<string, object>;
            if (o == null) throw new FormatException("JSON: a raiz não é um objeto");
            return o;
        }

        private sealed class Parser
        {
            private readonly string s;
            private int i;
            private readonly StringBuilder sb = new StringBuilder();

            public Parser(string text) { s = text; i = 0; }
            public bool End => i >= s.Length;
            public int Pos => i;

            public void SkipWs()
            {
                while (i < s.Length)
                {
                    char c = s[i];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '﻿') i++;
                    else break;
                }
            }

            public object ReadValue()
            {
                if (End) throw new FormatException("JSON: fim inesperado");
                char c = s[i];
                switch (c)
                {
                    case '{': return ReadObject();
                    case '[': return ReadArray();
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    case 'N': Expect("NaN"); return double.NaN;
                    default: return ReadNumber();
                }
            }

            private void Expect(string word)
            {
                if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0)
                    throw new FormatException("JSON: esperado '" + word + "' na posição " + i);
                i += word.Length;
            }

            private Dictionary<string, object> ReadObject()
            {
                var o = new Dictionary<string, object>();
                i++;
                SkipWs();
                if (i < s.Length && s[i] == '}') { i++; return o; }
                while (true)
                {
                    SkipWs();
                    if (End || s[i] != '"') throw new FormatException("JSON: chave esperada na posição " + i);
                    string key = ReadString();
                    SkipWs();
                    if (End || s[i] != ':') throw new FormatException("JSON: ':' esperado na posição " + i);
                    i++;
                    SkipWs();
                    o[key] = ReadValue();
                    SkipWs();
                    if (End) throw new FormatException("JSON: objeto não fechado");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return o; }
                    throw new FormatException("JSON: ',' ou '}' esperado na posição " + i);
                }
            }

            private List<object> ReadArray()
            {
                var a = new List<object>();
                i++;
                SkipWs();
                if (i < s.Length && s[i] == ']') { i++; return a; }
                while (true)
                {
                    SkipWs();
                    a.Add(ReadValue());
                    SkipWs();
                    if (End) throw new FormatException("JSON: array não fechado");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return a; }
                    throw new FormatException("JSON: ',' ou ']' esperado na posição " + i);
                }
            }

            private string ReadString()
            {
                sb.Length = 0;
                i++;
                while (i < s.Length)
                {
                    char c = s[i++];
                    if (c == '"') return sb.ToString();
                    if (c != '\\') { sb.Append(c); continue; }
                    if (i >= s.Length) break;
                    char e = s[i++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (i + 4 > s.Length) throw new FormatException("JSON: escape \\u incompleto");
                            sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            i += 4;
                            break;
                        default: throw new FormatException("JSON: escape inválido \\" + e);
                    }
                }
                throw new FormatException("JSON: string não fechada");
            }

            private object ReadNumber()
            {
                int start = i;
                if (i < s.Length && (s[i] == '-' || s[i] == '+')) i++;
                if (string.CompareOrdinal(s, i, "Infinity", 0, 8) == 0) { i += 8; return s[start] == '-' ? double.NegativeInfinity : double.PositiveInfinity; }
                while (i < s.Length)
                {
                    char c = s[i];
                    if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+') i++;
                    else break;
                }
                if (i == start) throw new FormatException("JSON: valor inválido na posição " + i);
                return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            }
        }
    }

    /// <summary>Acesso tipado e tolerante a ausências sobre o resultado de Json.Parse.</summary>
    public static class J
    {
        public static Dictionary<string, object> Obj(object o, string key)
        {
            var d = o as Dictionary<string, object>;
            if (d == null) return null;
            object v;
            return d.TryGetValue(key, out v) ? v as Dictionary<string, object> : null;
        }

        public static List<object> Arr(object o, string key)
        {
            var d = o as Dictionary<string, object>;
            if (d == null) return null;
            object v;
            return d.TryGetValue(key, out v) ? v as List<object> : null;
        }

        public static IEnumerable<Dictionary<string, object>> Objs(object o, string key)
        {
            var a = Arr(o, key);
            if (a == null) yield break;
            foreach (var x in a)
            {
                var d = x as Dictionary<string, object>;
                if (d != null) yield return d;
            }
        }

        public static object Get(object o, string key)
        {
            var d = o as Dictionary<string, object>;
            if (d == null) return null;
            object v;
            return d.TryGetValue(key, out v) ? v : null;
        }

        public static bool Has(object o, string key)
        {
            var d = o as Dictionary<string, object>;
            return d != null && d.ContainsKey(key) && d[key] != null;
        }

        public static string Str(object o, string key, string def = null)
        {
            var v = Get(o, key);
            return v == null ? def : (v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        public static double Num(object o, string key, double def = 0)
        {
            return ToDouble(Get(o, key), def);
        }

        public static float F(object o, string key, float def = 0f)
        {
            return (float)ToDouble(Get(o, key), def);
        }

        public static int Int(object o, string key, int def = 0)
        {
            var v = Get(o, key);
            return v == null ? def : (int)Math.Round(ToDouble(v, def));
        }

        public static bool Bool(object o, string key, bool def = false)
        {
            var v = Get(o, key);
            if (v is bool) return (bool)v;
            if (v is double) return (double)v != 0;
            return def;
        }

        public static double ToDouble(object v, double def = 0)
        {
            if (v is double) return (double)v;
            if (v is bool) return (bool)v ? 1 : 0;
            if (v is string)
            {
                double r;
                return double.TryParse((string)v, NumberStyles.Float, CultureInfo.InvariantCulture, out r) ? r : def;
            }
            return def;
        }

        public static float[] Floats(object list)
        {
            var a = list as List<object>;
            if (a == null) return new float[0];
            var r = new float[a.Count];
            for (int k = 0; k < a.Count; k++) r[k] = (float)ToDouble(a[k]);
            return r;
        }

        public static float[] Floats(object o, string key) { return Floats(Get(o, key)); }

        public static int[] Ints(object list)
        {
            var a = list as List<object>;
            if (a == null) return new int[0];
            var r = new int[a.Count];
            for (int k = 0; k < a.Count; k++) r[k] = (int)Math.Round(ToDouble(a[k]));
            return r;
        }

        public static int[] Ints(object o, string key) { return Ints(Get(o, key)); }

        public static List<string> Strings(object o, string key)
        {
            var r = new List<string>();
            var a = Arr(o, key);
            if (a == null) return r;
            foreach (var x in a) r.Add(x as string);
            return r;
        }
    }
}
