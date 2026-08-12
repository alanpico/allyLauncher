import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type GameEntry = {
  id: string;
  title: string;
  path: string;
  folder: string;
  extension: string;
  coverPath: string | null;
  favorite: boolean;
};

type LibrarySnapshot = {
  games: GameEntry[];
  folders: string[];
  favorites: string[];
  recent: string[];
  gamesFolder: string;
  launchOnStartup: boolean;
  theme: string;
  themes: string[];
  hasApiKey: boolean;
};

type SettingsView = {
  gamesFolder: string;
  launchOnStartup: boolean;
  theme: string;
  themes: string[];
  hasApiKey: boolean;
  steamGridDbApiKeySet: boolean;
};

type CategoryId = "all" | "favorites" | "recent" | `folder:${string}`;

const gridEl = () => document.querySelector<HTMLElement>("#game-grid")!;
const categoryBarEl = () => document.querySelector<HTMLElement>("#category-bar")!;
const emptyEl = () => document.querySelector<HTMLElement>("#empty-state")!;
const settingsDialog = () => document.querySelector<HTMLDialogElement>("#settings-dialog")!;
const themeStyleEl = document.createElement("style");
themeStyleEl.id = "theme-overrides";
document.head.appendChild(themeStyleEl);

let snapshot: LibrarySnapshot | null = null;
let activeCategory: CategoryId = "all";
let focusIndex = 0;
let visibleGames: GameEntry[] = [];

const buttonPrev: Record<number, boolean[]> = {};

function filteredGames(): GameEntry[] {
  if (!snapshot) return [];
  const byPath = new Map(snapshot.games.map((g) => [g.path, g]));

  if (activeCategory === "all") {
    return [...snapshot.games];
  }
  if (activeCategory === "favorites") {
    return snapshot.favorites
      .map((p) => byPath.get(p))
      .filter((g): g is GameEntry => Boolean(g));
  }
  if (activeCategory === "recent") {
    return snapshot.recent
      .map((p) => byPath.get(p))
      .filter((g): g is GameEntry => Boolean(g));
  }
  if (activeCategory.startsWith("folder:")) {
    const folder = activeCategory.slice("folder:".length);
    return snapshot.games.filter((g) => g.folder === folder);
  }
  return [...snapshot.games];
}

const coverCache = new Map<string, string>();

type AmbientPalette = {
  bg: string;
  glow: string;
  thumb: string;
};

const ambientCache = new Map<string, AmbientPalette>();
let ambientGen = 0;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToCss(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

function paletteFromRgb(r: number, g: number, b: number): AmbientPalette {
  const [h, s] = rgbToHsl(r, g, b);
  const mutedS = clamp(s * 0.55, 0.25, 0.4);
  return {
    bg: hslToCss(h, mutedS, 0.14),
    glow: hslToCss(h, mutedS, 0.24),
    thumb: hslToCss(h, clamp(s * 0.7, 0.28, 0.5), 0.56),
  };
}

function resetAmbient() {
  const root = document.documentElement;
  root.style.removeProperty("--bg");
  root.style.removeProperty("--bg-glow");
  root.style.removeProperty("--scrollbar-thumb");
}

function applyAmbient(palette: AmbientPalette) {
  const root = document.documentElement;
  root.style.setProperty("--bg", palette.bg);
  root.style.setProperty("--bg-glow", palette.glow);
  root.style.setProperty("--scrollbar-thumb", palette.thumb);
}

function sampleCoverPalette(dataUrl: string): Promise<AmbientPalette | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        const bins = new Map<number, { r: number; g: number; b: number; n: number }>();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 200) continue;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const light = (max + min) / 2;
          const sat = max === 0 ? 0 : (max - min) / max;
          if (light < 28 || light > 230 || sat < 0.18) continue;
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const bin = bins.get(key);
          if (bin) {
            bin.r += r;
            bin.g += g;
            bin.b += b;
            bin.n += 1;
          } else {
            bins.set(key, { r, g, b, n: 1 });
          }
        }
        let best: { r: number; g: number; b: number; n: number } | null = null;
        for (const bin of bins.values()) {
          if (!best || bin.n > best.n) best = bin;
        }
        if (!best) {
          resolve(null);
          return;
        }
        resolve(
          paletteFromRgb(
            Math.round(best.r / best.n),
            Math.round(best.g / best.n),
            Math.round(best.b / best.n),
          ),
        );
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function syncAmbient(game: GameEntry | undefined, gen: number) {
  if (!game?.coverPath) {
    if (gen === ambientGen) resetAmbient();
    return;
  }
  const cached = ambientCache.get(game.coverPath);
  if (cached) {
    if (gen === ambientGen) applyAmbient(cached);
    return;
  }
  const url = await coverUrl(game.coverPath);
  if (gen !== ambientGen) return;
  if (!url) {
    resetAmbient();
    return;
  }
  const palette = await sampleCoverPalette(url);
  if (gen !== ambientGen) return;
  if (!palette) {
    resetAmbient();
    return;
  }
  ambientCache.set(game.coverPath, palette);
  applyAmbient(palette);
}

/** Stable per-path idle/focus tilts so cards feel like a shuffled tarot deck. */
function cardTilt(path: string): { idle: number; focus: number } {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const sign = h & 1 ? 1 : -1;
  const idleMag = 1.2 + ((h >>> 1) % 18) / 10; // ~1.2°–2.9°
  const focusMag = 4.2 + ((h >>> 5) % 16) / 10; // ~4.2°–5.7°
  return { idle: sign * idleMag, focus: sign * focusMag };
}

async function coverUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const cached = coverCache.get(path);
  if (cached) return cached;
  try {
    const dataUrl = await invoke<string>("get_cover_data_url", { path });
    coverCache.set(path, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

function setFocusedTile(next: number) {
  if (!visibleGames.length) {
    ambientGen += 1;
    resetAmbient();
    return;
  }
  const grid = gridEl();
  const clamped = Math.max(0, Math.min(next, visibleGames.length - 1));
  if (clamped !== focusIndex) {
    grid.querySelector<HTMLElement>(".game-tile.focused")?.classList.remove("focused");
    focusIndex = clamped;
  }
  const tile = grid.querySelector<HTMLElement>(`.game-tile[data-index="${focusIndex}"]`);
  tile?.classList.add("focused");
  tile?.scrollIntoView({ block: "nearest", inline: "nearest" });
  ambientGen += 1;
  void syncAmbient(visibleGames[focusIndex], ambientGen);
}

function renderCategories() {
  if (!snapshot) return;
  const bar = categoryBarEl();
  const cats: { id: CategoryId; label: string }[] = [
    { id: "all", label: "All" },
    { id: "favorites", label: "Favorites" },
    { id: "recent", label: "Recent" },
    ...snapshot.folders.map((f) => ({ id: `folder:${f}` as CategoryId, label: f })),
  ];

  bar.innerHTML = "";
  for (const cat of cats) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `category-tab${cat.id === activeCategory ? " active" : ""}`;
    btn.textContent = cat.label;
    btn.dataset.category = cat.id;
    btn.addEventListener("click", () => {
      activeCategory = cat.id;
      focusIndex = 0;
      render();
    });
    bar.appendChild(btn);
  }
}

function renderGrid() {
  const grid = gridEl();
  visibleGames = filteredGames();
  grid.innerHTML = "";

  emptyEl().classList.toggle("hidden", visibleGames.length > 0);
  if (!visibleGames.length) {
    ambientGen += 1;
    resetAmbient();
    return;
  }

  visibleGames.forEach((game, index) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = `game-tile${index === focusIndex ? " focused" : ""}`;
    tile.dataset.path = game.path;
    tile.dataset.index = String(index);

    const tilt = cardTilt(game.path);
    tile.style.setProperty("--tilt", `${tilt.idle.toFixed(2)}deg`);
    tile.style.setProperty("--tilt-focus", `${tilt.focus.toFixed(2)}deg`);

    const coverWrap = document.createElement("div");
    coverWrap.className = "game-cover-wrap";

    const coverHost = document.createElement("div");
    coverHost.className = "game-cover placeholder";
    coverHost.textContent = "No art";
    coverWrap.appendChild(coverHost);

    if (game.coverPath) {
      void coverUrl(game.coverPath).then((url) => {
        if (!url) return;
        // Skip if this tile was re-rendered away
        if (!coverHost.isConnected) return;
        const img = document.createElement("img");
        img.className = "game-cover";
        img.src = url;
        img.alt = "";
        img.loading = "lazy";
        img.onerror = () => {
          if (coverHost.isConnected) coverHost.textContent = "No art";
        };
        coverHost.replaceWith(img);
      });
    }

    const title = document.createElement("div");
    title.className = "game-title";
    title.textContent = game.title;
    coverWrap.appendChild(title);

    if (game.favorite) {
      const badge = document.createElement("div");
      badge.className = "fav-badge";
      badge.textContent = "★";
      coverWrap.appendChild(badge);
    }

    tile.appendChild(coverWrap);

    tile.addEventListener("click", () => {
      setFocusedTile(index);
      void launch(game.path);
    });

    let pressTimer: number | undefined;
    tile.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        pressTimer = window.setTimeout(() => {
          void favorite(game.path);
        }, 550);
      }
    });
    const clear = () => {
      if (pressTimer) window.clearTimeout(pressTimer);
    };
    tile.addEventListener("pointerup", clear);
    tile.addEventListener("pointerleave", clear);
    tile.addEventListener("pointercancel", clear);

    tile.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void favorite(game.path);
    });

    grid.appendChild(tile);
  });

  ensureFocusVisible();
}

function render() {
  renderCategories();
  renderGrid();
}

function ensureFocusVisible() {
  if (!visibleGames.length) return;
  setFocusedTile(focusIndex);
}

function columnsEstimate(): number {
  const grid = gridEl();
  const tile = grid.querySelector(".game-tile");
  if (!tile) return 4;
  const gap = parseFloat(getComputedStyle(grid).gap || "16");
  const width = grid.clientWidth;
  const tileWidth = (tile as HTMLElement).offsetWidth || 140;
  return Math.max(1, Math.floor((width + gap) / (tileWidth + gap)));
}

async function launch(path: string) {
  await invoke("launch_game", { path });
}

async function favorite(path: string) {
  snapshot = await invoke<LibrarySnapshot>("toggle_favorite_cmd", { path });
  render();
}

async function applyTheme(name: string) {
  const css = await invoke<string>("get_theme_css", { name });
  themeStyleEl.textContent = css;
}

async function loadLibrary() {
  snapshot = await invoke<LibrarySnapshot>("get_library");
  await applyTheme(snapshot.theme);
  render();
  void invoke("fetch_missing_covers").catch(() => undefined);
}

async function openSettings() {
  const settings = await invoke<SettingsView>("get_settings");
  const folderInput = document.querySelector<HTMLInputElement>("#settings-games-folder")!;
  const startupInput = document.querySelector<HTMLInputElement>("#settings-startup")!;
  const apiInput = document.querySelector<HTMLInputElement>("#settings-api-key")!;
  const themeSelect = document.querySelector<HTMLSelectElement>("#settings-theme")!;

  folderInput.value = settings.gamesFolder;
  startupInput.checked = settings.launchOnStartup;
  apiInput.value = "";
  apiInput.placeholder = settings.steamGridDbApiKeySet
    ? "Key saved — enter to replace"
    : "Paste SteamGridDB API key";

  themeSelect.innerHTML = "";
  for (const theme of settings.themes) {
    const opt = document.createElement("option");
    opt.value = theme;
    opt.textContent = theme;
    if (theme === settings.theme) opt.selected = true;
    themeSelect.appendChild(opt);
  }

  settingsDialog().showModal();
}

async function saveSettings(submitter: string) {
  if (submitter !== "save") return;
  const folderInput = document.querySelector<HTMLInputElement>("#settings-games-folder")!;
  const startupInput = document.querySelector<HTMLInputElement>("#settings-startup")!;
  const apiInput = document.querySelector<HTMLInputElement>("#settings-api-key")!;
  const themeSelect = document.querySelector<HTMLSelectElement>("#settings-theme")!;

  const payload: Record<string, unknown> = {
    gamesFolder: folderInput.value.trim(),
    launchOnStartup: startupInput.checked,
    theme: themeSelect.value,
  };
  if (apiInput.value.trim()) {
    payload.steamGridDbApiKey = apiInput.value.trim();
  }

  await invoke("update_settings", payload);
  await loadLibrary();
}

function shiftCategory(delta: number) {
  const tabs = [...categoryBarEl().querySelectorAll<HTMLElement>(".category-tab")];
  if (!tabs.length) return;
  const current = tabs.findIndex((t) => t.classList.contains("active"));
  const next = (current + delta + tabs.length) % tabs.length;
  const id = tabs[next].dataset.category as CategoryId;
  activeCategory = id;
  focusIndex = 0;
  render();
}

function moveFocus(dx: number, dy: number) {
  if (!visibleGames.length) return;
  const cols = columnsEstimate();
  const next = focusIndex + dx + dy * cols;
  setFocusedTile(next);
}

function pollGamepad() {
  const pads = navigator.getGamepads?.() ?? [];
  for (const pad of pads) {
    if (!pad) continue;
    const prev = buttonPrev[pad.index] ?? [];
    const pressed = (i: number) => Boolean(pad.buttons[i]?.pressed) && !prev[i];

    // Xbox-style: 0 A, 1 B, 3 Y, 4 LB, 5 RB, 9 Start, 12–15 D-pad
    if (pressed(12)) moveFocus(0, -1);
    if (pressed(13)) moveFocus(0, 1);
    if (pressed(14)) moveFocus(-1, 0);
    if (pressed(15)) moveFocus(1, 0);
    if (pressed(0) && visibleGames[focusIndex]) void launch(visibleGames[focusIndex].path);
    if (pressed(3) && visibleGames[focusIndex]) void favorite(visibleGames[focusIndex].path);
    if (pressed(4)) shiftCategory(-1);
    if (pressed(5)) shiftCategory(1);
    if (pressed(9)) void openSettings();
    if (pressed(1)) {
      if (settingsDialog().open) settingsDialog().close();
    }

    // Left stick threshold
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const now = performance.now();
    const key = `stick-${pad.index}`;
    const last = Number((window as unknown as Record<string, number>)[key] ?? 0);
    if (now - last > 180) {
      if (ax < -0.55) {
        moveFocus(-1, 0);
        (window as unknown as Record<string, number>)[key] = now;
      } else if (ax > 0.55) {
        moveFocus(1, 0);
        (window as unknown as Record<string, number>)[key] = now;
      } else if (ay < -0.55) {
        moveFocus(0, -1);
        (window as unknown as Record<string, number>)[key] = now;
      } else if (ay > 0.55) {
        moveFocus(0, 1);
        (window as unknown as Record<string, number>)[key] = now;
      }
    }

    buttonPrev[pad.index] = pad.buttons.map((b) => Boolean(b.pressed));
  }
  requestAnimationFrame(pollGamepad);
}

window.addEventListener("DOMContentLoaded", async () => {
  document.querySelector("#btn-settings")?.addEventListener("click", () => void openSettings());
  document.querySelector("#btn-open-folder")?.addEventListener("click", () => {
    void invoke("open_games_folder");
  });
  document.querySelector("#btn-open-themes")?.addEventListener("click", () => {
    void invoke("open_themes_folder");
  });
  document.querySelector("#btn-fetch-covers")?.addEventListener("click", async () => {
    snapshot = await invoke<LibrarySnapshot>("fetch_missing_covers");
    render();
  });

  document.querySelector("#settings-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const submitter = ((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? "cancel";
    settingsDialog().close();
    void saveSettings(submitter);
  });

  window.addEventListener("keydown", (e) => {
    if (settingsDialog().open) return;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(-1, 0);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(1, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(0, -1);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(0, 1);
        break;
      case "Enter":
        if (visibleGames[focusIndex]) void launch(visibleGames[focusIndex].path);
        break;
      case "f":
      case "F":
        if (visibleGames[focusIndex]) void favorite(visibleGames[focusIndex].path);
        break;
      case "[":
        shiftCategory(-1);
        break;
      case "]":
        shiftCategory(1);
        break;
      case "Escape":
        void invoke("hide_window");
        break;
    }
  });

  await listen<LibrarySnapshot>("library-updated", (event) => {
    snapshot = event.payload;
    render();
  });

  await listen<boolean>("open-settings", (event) => {
    if (event.payload) void openSettings();
  });

  await loadLibrary();
  requestAnimationFrame(pollGamepad);
  gridEl().focus();
});
