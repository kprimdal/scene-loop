import { $ } from "./util.js";
import { S, api, tc } from "./state.js";
import { renderFilmstrip } from "./filmstrip.js";
import { renderVersions } from "./versions.js";
import { loadChat, renderPanel } from "./panel.js";
import { renderRenders } from "./renders.js";
import { renderScript } from "./script.js";
import { renderRecord } from "./record.js";
import { loadPlayer } from "./stage.js";
import { renderMusicMenu } from "./library.js";

const Q = new URLSearchParams(location.search);

// The view modules call refresh after writes, while refresh calls their render functions.
// This cycle is safe because calls happen only after every module has evaluated.

// ---------- data ----------
export async function refresh() {
  if (S.overview) return;
  S.data = await api("/api/project");
  if (!S.data.scenes.some((s) => s.id === S.sel)) {
    // first open, or the selected scene was removed: move to the one in the URL or the first, chat included
    S.sel = S.data.scenes.find((s) => s.id === Q.get("scene"))?.id ?? S.data.scenes[0].id;
    S.compare = null;
    loadChat();
  }
  document.title = `${S.data.title} · Scene loop`;
  $("#meta").textContent = `${S.data.scenes.length} scenes · ${tc(S.data.duration)}`;
  renderFilmstrip();
  renderVersions();
  renderPanel();
  renderRenders();
  $("#musicBtn").classList.toggle("on", !!S.data.music);
  $("#musicBtn").title = S.data.music ? `Music bed: ${S.data.music}${S.data.musicLibrary ? ` (library ${S.data.musicLibrary})` : ""}` : "No music bed. Pick one from the library.";
  $("#libraryBtn").href = "/?" + new URLSearchParams({ library: "1", project: S.project, video: S.video, scene: S.sel });
  renderMusicMenu();
  if (S.script) renderScript();
  if (S.record) return renderRecord();
  await loadPlayer();
}
