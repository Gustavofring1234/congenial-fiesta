// Configuração da Gemini API para ganchos opcionais no runtime do navegador.
//
// A chave NÃO deve ser gravada aqui se a pasta for publicada: qualquer visitante a leria.
// Para uso local, troque o marcador abaixo ou defina a chave só neste navegador, no console:
//   localStorage.setItem('GEMINI_API_KEY', '<sua chave>')
// Os scripts offline (tools/gemini_client.py) leem a chave do arquivo .env.
export const GEMINI_API_KEY = 'INSIRA_SUA_CHAVE_AQUI';
export const GEMINI_MODEL = 'gemini-flash-latest';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const PLACEHOLDER = 'INSIRA_SUA_CHAVE_AQUI';

function storedKey() {
  try { return localStorage.getItem('GEMINI_API_KEY'); } catch { return null; }
}

export function geminiKey() {
  const k = storedKey() || GEMINI_API_KEY;
  return k && k !== PLACEHOLDER ? k : null;
}

export const geminiEnabled = () => geminiKey() !== null;

/** generateContent; devolve o texto da resposta (ou o JSON, com json: true). Lança erro se não configurada. */
export async function geminiGenerate(prompt, { system, json = false, temperature = 0.2, signal } = {}) {
  const key = geminiKey();
  if (!key) throw new Error('Gemini API não configurada (GEMINI_API_KEY)');
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig.responseMimeType = 'application/json';
  const r = await fetch(`${ENDPOINT}/${GEMINI_MODEL}:generateContent`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return json ? JSON.parse(text) : text;
}
