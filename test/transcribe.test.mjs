// transcribe_narration: the host's speech service (Azure AI Speech) transcribes a scene's narration
// audio, and the words are stored as set_narration_words stores them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { transcribeSettings, createTranscriber, phrasesOf } from "../lib/transcribe.mjs";
import { narrationWords } from "../lib/words.mjs";
import { createRegistry, TEMPLATE_DIR } from "../lib/projects.mjs";
import { callTool } from "../lib/tools.mjs";

// What fast transcription answers, trimmed: words in milliseconds, punctuation on the word.
const answer = (pairs) => ({
  durationMilliseconds: 3000,
  combinedPhrases: [{ text: pairs.map(([w]) => w).join(" ") }],
  phrases: [{ offsetMilliseconds: 100, durationMilliseconds: 2000, text: pairs.map(([w]) => w).join(" "), words: pairs.map(([text, at]) => ({ text, offsetMilliseconds: at, durationMilliseconds: 300 })) }],
});

test("phrasesOf: names, acronyms and runs of them; not a sentence's first word", () => {
  const script = "Planning matters at Nordlys. UNESCO and Kew Gardens found Quercus robur in MK2 plots, Søholm too. Choose well.";
  assert.deepEqual(phrasesOf(script), ["Nordlys", "UNESCO", "Kew Gardens", "Quercus", "MK2", "Søholm"]);
  assert.deepEqual(phrasesOf("We met Nordlys, Søholm and ScanTech."), ["Nordlys", "Søholm", "ScanTech"]);
  assert.deepEqual(phrasesOf(""), []);
});

test("Azure JSON becomes words with seconds and the script's spelling", () => {
  const azure = answer([["Cleaning", 100], ["at", 500], ["Nordlys.", 800]]);
  const r = narrationWords({ azure, script: "Cleaning at Nordlys." });
  assert.deepEqual(r.words, [{ word: "Cleaning", start: 0.1, end: 0.4 }, { word: "at", start: 0.5, end: 0.8 }, { word: "Nordlys.", start: 0.8, end: 1.1 }]);
  assert.throws(() => narrationWords({ azure: { nope: 1 } }), /phrases/);
  // a phrase the service heard but did not time fails the whole answer, rather than losing it
  const partly = { phrases: [...answer([["Hello.", 100]]).phrases, { offsetMilliseconds: 900, durationMilliseconds: 500, text: "Goodbye." }] };
  assert.throws(() => narrationWords({ azure: partly, script: "Hello. Goodbye." }), /without word times: "Goodbye\."/);
  assert.throws(() => narrationWords({ azure, words: [] }), /exactly one/);
});

test("settings: off without an endpoint, and a way to sign in is required", () => {
  assert.equal(transcribeSettings({}), null);
  assert.throws(() => transcribeSettings({ SCENE_LOOP_AZURE_SPEECH_ENDPOINT: "https://x.cognitiveservices.azure.com" }), /no way to sign in/);
  assert.throws(() => transcribeSettings({ SCENE_LOOP_AZURE_SPEECH_ENDPOINT: "http://x", SCENE_LOOP_AZURE_SPEECH_KEY: "k" }), /must be https/);
  const s = transcribeSettings({ SCENE_LOOP_AZURE_SPEECH_ENDPOINT: "https://x.cognitiveservices.azure.com/", IDENTITY_ENDPOINT: "http://id", IDENTITY_HEADER: "h", AZURE_CLIENT_ID: "cid", SCENE_LOOP_AZURE_SPEECH_LOCALE: "en-US,da-DK" });
  assert.equal(s.endpoint, "https://x.cognitiveservices.azure.com");
  assert.deepEqual(s.locales, ["en-US", "da-DK"]);
  assert.equal(s.identity.clientId, "cid");
  assert.equal(s.key, null);
});

function audioFile() {
  const dir = mkdtempSync(join(tmpdir(), "sl-stt-"));
  const file = join(dir, "voice.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-ar", "16000", file]);
  return file;
}

test("managed identity: one token, reused, sent as a bearer; phrase list and locale in the definition", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("http://id")) return Response.json({ access_token: "tok", expires_on: String(Math.floor(Date.now() / 1000) + 3600) });
    const definition = JSON.parse(init.body.get("definition"));
    assert.deepEqual(definition, { locales: ["da-DK"], phraseList: { phrases: ["Nordlys", "UNESCO"] } });
    assert.ok(init.body.get("audio") instanceof Blob);
    return Response.json(answer([["Hej", 100]]));
  };
  const t = createTranscriber(transcribeSettings({ SCENE_LOOP_AZURE_SPEECH_ENDPOINT: "https://x.cognitiveservices.azure.com", IDENTITY_ENDPOINT: "http://id/token", IDENTITY_HEADER: "secret-h", AZURE_CLIENT_ID: "cid" }), { fetchImpl });
  const file = audioFile();
  await t.transcribe(file, { locale: "da-DK", phrases: ["Nordlys", "UNESCO", "Nordlys", " "] });
  await t.transcribe(file, { locale: "da-DK", phrases: ["Nordlys", "UNESCO"] });
  const id = calls.filter((c) => c.url.startsWith("http://id"));
  assert.equal(id.length, 1);
  const u = new URL(id[0].url);
  assert.equal(u.searchParams.get("resource"), "https://cognitiveservices.azure.com");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(id[0].init.headers["X-IDENTITY-HEADER"], "secret-h");
  const speech = calls.filter((c) => !c.url.startsWith("http://id"));
  assert.equal(speech.length, 2);
  assert.match(speech[0].url, /^https:\/\/x\.cognitiveservices\.azure\.com\/speechtotext\/transcriptions:transcribe\?api-version=2025-10-15$/);
  assert.equal(speech[0].init.headers.Authorization, "Bearer tok");
});

test("a key outside Azure; a refusal names the missing role", async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers["Ocp-Apim-Subscription-Key"], "k");
    return new Response(JSON.stringify({ error: { message: "Principal does not have access" } }), { status: 403 });
  };
  const t = createTranscriber(transcribeSettings({ SCENE_LOOP_AZURE_SPEECH_ENDPOINT: "https://x.cognitiveservices.azure.com", SCENE_LOOP_AZURE_SPEECH_KEY: "k" }), { fetchImpl });
  await assert.rejects(t.transcribe(audioFile()), /403: Principal does not have access.*Cognitive Services User/);
});

test("transcribe_narration stores the words of every scene without them, and says when there is no service", async () => {
  const root = mkdtempSync(join(tmpdir(), "sl-stt-reg-"));
  cpSync(TEMPLATE_DIR, join(root, "p", "videos", "v"), { recursive: true });
  const registry = createRegistry(root, { reviewer: "Tester", emit() {} });
  const sent = [];
  const transcriber = { service: "Azure AI Speech", transcribe: async (file, opts) => (sent.push({ file, opts }), answer([["Choose", 200], ["one", 600], ["idea", 900], ["at", 1300], ["Nordlys.", 1600]])) };
  const call = (name, args = {}, more = {}) => callTool(name, { project: "p", video: "v", model: "Tester", ...args }, { registry, via: "page-js", origin: "http://localhost", transcriber, ...more });
  const { scenes } = await call("list_scenes");
  const id = scenes[0].id;
  await call("update_scene", { scene: id, narration: "Choose one idea at Nordlys." });
  await call("set_narration_audio", { scene: id, path: audioFile() });

  assert.equal((await call("list_takes")).transcription, "Azure AI Speech");
  const r = await call("transcribe_narration", { adopt: false });
  assert.equal(r.service, "Azure AI Speech");
  assert.equal(r.scenes.length, 1);
  assert.equal(r.scenes[0].scene, id);
  assert.ok(!r.scenes[0].error, r.scenes[0].error);
  assert.deepEqual(sent[0].opts.phrases, ["Nordlys"]);
  const video = await registry.get("p", "v");
  const stored = JSON.parse(readFileSync(join(video.dir, "assets", "narration", `${id}.words.json`), "utf8"));
  assert.deepEqual(stored.map((w) => w.word), ["Choose", "one", "idea", "at", "Nordlys."]);
  assert.equal(stored[4].start, 1.6);

  // nothing left without words: nothing sent, and a note says how to redo one
  const again = await call("transcribe_narration", {});
  assert.equal(again.scenes.length, 0);
  assert.match(again.note, /pass scenes/);
  assert.equal(sent.length, 1);

  // a scene with no audio is reported, not thrown
  const bad = await call("transcribe_narration", { scenes: [scenes[1]?.id ?? "nope"] });
  assert.ok(bad.scenes[0].error);

  await assert.rejects(call("transcribe_narration", {}, { transcriber: null }), /no speech service.*set_narration_words/);
  assert.equal((await call("list_takes", {}, { transcriber: null })).transcription, null);
  assert.ok(existsSync(video.dir));
});

test("transcribe_narration: audio changed while it was out is not given the old words; a broken file does not stop the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "sl-stt-race-"));
  cpSync(TEMPLATE_DIR, join(root, "p", "videos", "v"), { recursive: true });
  const registry = createRegistry(root, { reviewer: "Tester", emit() {} });
  let during = async () => {};
  const transcriber = { service: "Azure AI Speech", transcribe: async () => { await during(); return answer([["Choose", 200], ["one", 600]]); } };
  const call = (name, args = {}) => callTool(name, { project: "p", video: "v", model: "Tester", ...args }, { registry, via: "page-js", origin: "http://localhost", transcriber });
  const { scenes } = await call("list_scenes");
  const a = scenes[0].id;
  const { scene: b } = await call("create_scene", { title: "Second", duration: 3, narration: "Choose one." });
  const video = await registry.get("p", "v");
  const wordsOf = (id) => join(video.dir, "assets", "narration", `${id}.words.json`);
  await call("update_scene", { scene: a, narration: "Choose one." });
  await call("set_narration_audio", { scene: a, path: audioFile() });

  // another take lands while the service works: the old words are refused, nothing stored
  during = async () => { await call("set_narration_audio", { scene: a, path: audioFile() }); };
  const raced = await call("transcribe_narration", { scenes: [a], adopt: false });
  assert.match(raced.scenes[0].error, /changed while it was being transcribed/);
  assert.equal(existsSync(wordsOf(a)), false);

  // scene b's audio is not audio at all: scene a is still transcribed
  during = async () => {};
  writeFileSync(join(video.dir, "assets", "narration", `${b}.wav`), "not audio");
  const r = await call("transcribe_narration", { scenes: [a], adopt: false });
  assert.ok(!r.scenes[0].error, r.scenes[0].error);
  assert.equal(existsSync(wordsOf(a)), true);
  const both = await call("transcribe_narration", { scenes: [b, a], adopt: false });
  assert.equal(both.scenes.length, 2);
  assert.ok(both.scenes.find((x) => x.scene === a && !x.error));
});
