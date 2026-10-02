import { $ } from "./util.js";
import { S, scene, fps, toFrame } from "./state.js";
import { player, duration } from "./stage.js";
import { closePop, startComment } from "./comments.js";
import { openInstructions } from "./instructions.js";
import { setScript } from "./script.js";
import { flip, showVersions } from "./versions.js";
import { selectScene } from "./filmstrip.js";

// ---------- keys ----------
window.addEventListener("keydown", (e) => {
  if (/TEXTAREA|INPUT/.test(document.activeElement?.tagName) || e.repeat || e.metaKey || e.ctrlKey) return;
  if (!$("#drawer").hidden) return;
  if (e.key === "Escape") return closePop();
  if (e.key === "i" && !S.overview) return openInstructions();
  if (S.overview) return;
  if (e.key === "s") return setScript();
  if (e.key === " ") (e.preventDefault(), player.paused === false ? player.pause() : player.play());
  if (e.key === "c") startComment();
  if (e.key === "f") flip();
  if (e.key === "v") showVersions();
  // One frame per arrow, on the frame grid; shift steps a second.
  if (e.key === "ArrowLeft") player.seek(Math.max(0, (toFrame(player.currentTime) - (e.shiftKey ? fps() : 1)) / fps()));
  if (e.key === "ArrowRight") player.seek(Math.min(duration() - 1 / fps(), (toFrame(player.currentTime) + (e.shiftKey ? fps() : 1)) / fps()));
  const i = S.data.scenes.indexOf(scene());
  if (e.key === "[" && i > 0) selectScene(S.data.scenes[i - 1].id, true);
  if (e.key === "]" && i < S.data.scenes.length - 1) selectScene(S.data.scenes[i + 1].id, true);
});
