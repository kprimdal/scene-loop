// Transcription by a speech service the host runs, so an agent without a key of its own can still
// get a take's words (transcribe_narration). Optional: on when SCENE_LOOP_AZURE_SPEECH_ENDPOINT
// is set. Without it the agent transcribes the audio itself and passes the JSON to
// set_narration_words, as before.
//
// Azure AI Speech, fast transcription (one request per file, word times in the answer). The
// server holds no key when it runs in Azure: it signs in with its managed identity (Azure
// Container Apps and App Service set IDENTITY_ENDPOINT and IDENTITY_HEADER), and the identity
// needs the "Cognitive Services User" role on the Speech resource. The endpoint must be the
// resource's own subdomain (https://<name>.cognitiveservices.azure.com), since tokens are not
// accepted on the regional one. SCENE_LOOP_AZURE_SPEECH_KEY is for a server outside Azure.
// No dependency: fetch, FormData and Blob are in Node 22.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const RESOURCE = "https://cognitiveservices.azure.com";
const MAX_PHRASES = 100;

export function transcribeSettings(env = process.env) {
  const endpoint = env.SCENE_LOOP_AZURE_SPEECH_ENDPOINT?.trim().replace(/\/+$/, "");
  if (!endpoint) return null;
  if (!/^https:\/\/[\w.-]+$/.test(endpoint)) throw new Error(`SCENE_LOOP_AZURE_SPEECH_ENDPOINT must be https://<resource>.cognitiveservices.azure.com, not "${endpoint}"`);
  const key = env.SCENE_LOOP_AZURE_SPEECH_KEY?.trim() || null;
  const identity = env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER
    ? { endpoint: env.IDENTITY_ENDPOINT, header: env.IDENTITY_HEADER, clientId: env.SCENE_LOOP_AZURE_SPEECH_CLIENT_ID?.trim() || env.AZURE_CLIENT_ID?.trim() || null }
    : null;
  if (!key && !identity) throw new Error("SCENE_LOOP_AZURE_SPEECH_ENDPOINT is set, but there is no way to sign in: run in Azure with a managed identity (IDENTITY_ENDPOINT), or set SCENE_LOOP_AZURE_SPEECH_KEY.");
  const locales = (env.SCENE_LOOP_AZURE_SPEECH_LOCALE || "en-US").split(/[\s,]+/).filter(Boolean);
  return { endpoint, key, identity, locales, apiVersion: env.SCENE_LOOP_AZURE_SPEECH_API_VERSION?.trim() || "2025-10-15" };
}

// The names and terms in a script, for the service's phrase list: words with a capital after
// their first letter (UNESCO, ScanTech), capitalised words that do not start a sentence, and words
// with letters and digits together, with runs of them kept as one phrase (Campden BRI). A
// sentence's first word is left out, since its capital says nothing.
export function phrasesOf(script) {
  const out = [];
  let run = [];
  const flush = () => { if (run.length) out.push(run.join(" ")); run = []; };
  let sentenceStart = true;
  for (const raw of String(script ?? "").split(/\s+/).filter(Boolean)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const named = word && (/\p{Lu}/u.test(word.slice(1)) || (/\p{L}/u.test(word) && /\p{N}/u.test(word)) || (!sentenceStart && /^\p{Lu}/u.test(word)));
    if (named) run.push(word); else flush();
    if (/[^\p{L}\p{N}]+$/u.test(raw) && raw !== word) flush(); // "Nordlys, Søholm" are two names
    sentenceStart = /[.!?:]["'”’)]*$/u.test(raw);
  }
  flush();
  return [...new Set(out)].slice(0, MAX_PHRASES);
}

export function createTranscriber(settings, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const { endpoint, key, identity, locales, apiVersion } = settings;
  let token = null, tokenUntil = 0;

  async function auth() {
    if (key) return { "Ocp-Apim-Subscription-Key": key };
    if (!token || now() > tokenUntil) {
      const url = new URL(identity.endpoint);
      url.searchParams.set("resource", RESOURCE);
      url.searchParams.set("api-version", "2019-08-01");
      if (identity.clientId) url.searchParams.set("client_id", identity.clientId);
      const r = await fetchImpl(url, { headers: { "X-IDENTITY-HEADER": identity.header }, signal: AbortSignal.timeout(10_000) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.access_token) throw new Error(`The managed identity gave no token for Azure AI Speech (${r.status}${body.error_description ? `: ${body.error_description}` : body.error ? `: ${body.error}` : ""})`);
      token = body.access_token;
      // five minutes before it runs out; expires_on is in seconds
      tokenUntil = Number(body.expires_on) ? Number(body.expires_on) * 1000 - 300_000 : now() + 600_000;
    }
    return { Authorization: `Bearer ${token}` };
  }

  // The raw answer: { durationMilliseconds, combinedPhrases, phrases: [{ words: [...] }] }.
  async function transcribe(file, { locale, phrases = [] } = {}) {
    const definition = { locales: locale ? [locale] : locales };
    const list = [...new Set(phrases.map((p) => String(p).trim()).filter(Boolean))].slice(0, MAX_PHRASES);
    if (list.length) definition.phraseList = { phrases: list };
    const form = new FormData();
    form.append("audio", new Blob([readFileSync(file)]), basename(file));
    form.append("definition", JSON.stringify(definition));
    const r = await fetchImpl(`${endpoint}/speechtotext/transcriptions:transcribe?api-version=${apiVersion}`, { method: "POST", headers: await auth(), body: form, signal: AbortSignal.timeout(300_000) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) token = null;
      const why = body?.error?.message ?? body?.message ?? body?.title ?? text.slice(0, 300);
      throw new Error(`Azure AI Speech answered ${r.status}: ${why}${r.status === 401 || r.status === 403 ? " (does the server's identity have the Cognitive Services User role on the Speech resource?)" : ""}`);
    }
    if (!Array.isArray(body?.phrases)) throw new Error("Azure AI Speech answered without phrases");
    return body;
  }

  return { service: "Azure AI Speech", locales, transcribe };
}

let cached;
// The server's transcriber from the environment, or null when none is set up. A setting that is
// wrong throws on first use, so the agent sees the reason instead of a missing tool.
export function defaultTranscriber() {
  if (cached === undefined) {
    const settings = transcribeSettings();
    cached = settings ? createTranscriber(settings) : null;
  }
  return cached;
}
