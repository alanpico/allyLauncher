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

const EMPTY_LIBRARY_COPY =
  'Drop <code>.lnk</code> or <code>.url</code> shortcuts into your games folder.';
const EMPTY_FAVORITES_COPY =
  'No favorites yet — press <kbd class="pad-btn pad-y">Y</kbd> on a game.';

const FATE_PATHS = [
  "M0 12 C 22 3, 38 21, 60 12 S 98 5, 120 12",
  "M0 12 C 18 19, 44 4, 60 12 S 96 20, 120 12",
  "M0 12 C 24 6, 36 18, 60 11 S 100 8, 120 12",
];

const THEME_LABELS: Record<string, string> = {
  default: "Default",
  "ornate-grid": "Ornate grid",
  "hero-deck": "Hero deck",
};

const gridEl = () => document.querySelector<HTMLElement>("#game-grid")!;
const shellEl = () => document.querySelector<HTMLElement>("#app")!;
const categoryBarEl = () => document.querySelector<HTMLElement>("#category-bar")!;
const emptyEl = () => document.querySelector<HTMLElement>("#empty-state")!;
const settingsDialog = () => document.querySelector<HTMLDialogElement>("#settings-dialog")!;
const themeStyleEl = document.createElement("style");
themeStyleEl.id = "theme-overrides";
document.head.appendChild(themeStyleEl);

let snapshot: LibrarySnapshot | null = null;
let activeCategory: CategoryId = "all";
let pickedInitialCategory = false;
let focusIndex = 0;
let visibleGames: GameEntry[] = [];
let carouselSuppressClick = false;
let carouselDragging = false;
let activeLayout: "default" | "ornate-grid" | "hero-deck" = "default";

const buttonPrev: Record<number, boolean[]> = {};

function isFavView(): boolean {
  return activeCategory === "favorites";
}

function isHeroDeckLayout(): boolean {
  return activeLayout === "hero-deck" && !isFavView();
}

function isHorizontalBrowse(): boolean {
  return isFavView() || isHeroDeckLayout();
}

function browseScrollEl(): HTMLElement {
  if (isHeroDeckLayout()) {
    return gridEl().querySelector<HTMLElement>(".card-hand") ?? gridEl();
  }
  return gridEl();
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
  if (isFavView()) {
    root.style.setProperty("--bg", `color-mix(in srgb, ${palette.bg} 70%, #3a1e10)`);
    root.style.setProperty("--bg-glow", `color-mix(in srgb, ${palette.glow} 52%, #6a3a12)`);
    root.style.setProperty("--scrollbar-thumb", `color-mix(in srgb, ${palette.thumb} 68%, #c4a06a)`);
    return;
  }
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

function clearTarotFlip(tile: HTMLElement | null) {
  const flipper = tile?.querySelector<HTMLElement>(".card-flipper");
  if (!flipper) return;
  flipper.style.transition = "none";
  flipper.style.transform = "rotateY(0deg)";
}

function playTarotFlip(tile: HTMLElement | null) {
  if (!tile || prefersReducedMotion()) return;
  const flipper = tile.querySelector<HTMLElement>(".card-flipper");
  if (!flipper) return;
  flipper.style.transition = "none";
  flipper.style.transform = "rotateY(0deg)";
  void flipper.offsetWidth;
  flipper.style.transition = "transform 0.52s cubic-bezier(0.4, 0.02, 0.2, 1)";
  flipper.style.transform = "rotateY(360deg)";
}

function setFocusedTile(next: number) {
  if (!visibleGames.length) {
    ambientGen += 1;
    resetAmbient();
    return;
  }
  const grid = gridEl();
  const clamped = Math.max(0, Math.min(next, visibleGames.length - 1));
  const moved = clamped !== focusIndex;
  if (moved) {
    const prev = grid.querySelector<HTMLElement>(".game-tile.focused");
    prev?.classList.remove("focused");
    if (isFavView()) clearTarotFlip(prev);
    focusIndex = clamped;
  }
  const tile = grid.querySelector<HTMLElement>(`.game-tile[data-index="${focusIndex}"]`);
  tile?.classList.add("focused");
  if (isFavView()) updateFavoriteFan();
  if (isHeroDeckLayout()) syncHeroStage();
  revealFocusedTile(tile);
  if (moved && isFavView()) playTarotFlip(tile);
  ambientGen += 1;
  void syncAmbient(visibleGames[focusIndex], ambientGen);
}

/** Keep the focused card fully in view, including scale/tilt overflow at the first row. */
function revealFocusedTile(tile: HTMLElement | null) {
  if (!tile) return;
  if (isHorizontalBrowse()) {
    const scroller = browseScrollEl();
    const tileCenter = tile.offsetLeft + tile.offsetWidth / 2;
    const target = tileCenter - scroller.clientWidth / 2;
    scroller.scrollTo({ left: Math.max(0, target), behavior: "auto" });
    return;
  }
  const grid = gridEl();
  const cols = columnsEstimate();
  if (focusIndex < cols) {
    grid.scrollTop = 0;
    return;
  }
  tile.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Arc / table-spread offsets for the Favorites carousel. */
function updateFavoriteFan() {
  const grid = gridEl();
  grid.querySelectorAll<HTMLElement>(".game-tile").forEach((tile) => {
    const index = Number(tile.dataset.index ?? 0);
    const dist = index - focusIndex;
    const abs = Math.abs(dist);
    tile.style.setProperty("--fan-offset", String(dist));
    tile.style.setProperty("--fan-abs", String(abs));
    tile.classList.toggle("fan-near", abs === 1);
    tile.classList.toggle("fan-far", abs >= 2);
  });
}

function syncHeroStage() {
  const stage = gridEl().querySelector<HTMLElement>(".hero-stage");
  if (!stage) return;
  const game = visibleGames[focusIndex];
  stage.innerHTML = "";
  if (!game) return;

  const card = document.createElement("div");
  card.className = "hero-card";
  const tilt = cardTilt(game.path);
  card.style.setProperty("--tilt", `${tilt.focus.toFixed(2)}deg`);

  const coverWrap = document.createElement("div");
  coverWrap.className = "game-cover-wrap";
  fillCover(coverWrap, game);
  card.appendChild(coverWrap);
  stage.appendChild(card);

  gridEl().querySelectorAll<HTMLElement>(".deck-wall-card").forEach((el) => {
    el.classList.toggle("is-focus", el.dataset.path === game.path);
  });
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

function syncFavoritesMode() {
  const shell = shellEl();
  const grid = gridEl();
  shell.dataset.layout = activeLayout;
  document.documentElement.dataset.layout = activeLayout;

  if (isFavView()) {
    shell.dataset.category = "favorites";
    grid.dataset.category = "favorites";
    grid.classList.add("fav-carousel");
    grid.classList.remove("hero-deck");
  } else {
    delete shell.dataset.category;
    delete grid.dataset.category;
    grid.classList.remove("fav-carousel");
    grid.classList.toggle("hero-deck", activeLayout === "hero-deck");
    grid.scrollLeft = 0;
  }
}

function updateEmptyState(hasVisible: boolean) {
  const empty = emptyEl();
  empty.classList.toggle("hidden", hasVisible);
  empty.classList.toggle("empty-favorites", !hasVisible && isFavView());
  if (hasVisible) return;
  const libraryEmpty = !snapshot || snapshot.games.length === 0;
  if (isFavView() && !libraryEmpty) {
    empty.innerHTML = EMPTY_FAVORITES_COPY;
  } else {
    empty.innerHTML = EMPTY_LIBRARY_COPY;
  }
}

function makeFateSpan(kind: "lead" | "gap" | "tail", variant: number): HTMLElement {
  const span = document.createElement("div");
  span.className = `fate-span fate-span-${kind}`;
  span.setAttribute("aria-hidden", "true");
  const d = FATE_PATHS[variant % FATE_PATHS.length];
  span.innerHTML = `
    <svg class="fate-string" viewBox="0 0 120 24" preserveAspectRatio="none">
      <path class="fate-cord" d="${d}" />
      <path class="fate-cord-fine" d="${d}" />
    </svg>
    ${kind === "gap" ? '<span class="fate-bead"></span>' : ""}
  `;
  return span;
}

function makeTarotBack(): HTMLElement {
  const back = document.createElement("div");
  back.className = "tarot-back";
  back.setAttribute("aria-hidden", "true");
  return back;
}

function makeCardFrame(): HTMLElement {
  const frame = document.createElement("div");
  frame.className = "card-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.innerHTML = `
    <svg class="card-frame-svg" viewBox="0 0 200 300" fill="none" preserveAspectRatio="none">
      <rect x="6" y="6" width="188" height="288" rx="8" stroke="currentColor" stroke-width="3.2" opacity="0.95"/>
      <rect x="12" y="12" width="176" height="276" rx="6" stroke="currentColor" stroke-width="0.7" opacity="0.55"/>
      <rect x="18" y="18" width="164" height="264" rx="4" stroke="currentColor" stroke-width="1.35" opacity="0.88"/>
      <rect x="24" y="24" width="152" height="252" rx="2.5" stroke="currentColor" stroke-width="0.55" opacity="0.4"/>
      <g stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" opacity="0.92">
        <path d="M28 46 V34 H40"/>
        <path d="M28 40 H36 V34"/>
        <path d="M34 46 L40 40"/>
        <path d="M172 46 V34 H160"/>
        <path d="M172 40 H164 V34"/>
        <path d="M166 46 L160 40"/>
        <path d="M28 254 V266 H40"/>
        <path d="M28 260 H36 V266"/>
        <path d="M34 254 L40 260"/>
        <path d="M172 254 V266 H160"/>
        <path d="M172 260 H164 V266"/>
        <path d="M166 254 L160 260"/>
      </g>
      <g stroke="currentColor" stroke-width="1" opacity="0.55">
        <path d="M18 150 H24"/>
        <path d="M182 150 H176"/>
        <path d="M100 18 V24"/>
      </g>
      <g transform="translate(100 268)" stroke="currentColor" fill="none">
        <circle r="9.5" stroke-width="1.4" opacity="0.95"/>
        <circle r="6.2" stroke-width="0.7" opacity="0.65"/>
        <path d="M0-5.2 L1.2-1.5 H5 L2 0.8 L3.1 4.5 L0 2.4 L-3.1 4.5 L-2 0.8 L-5-1.5 H-1.2 Z" stroke-width="0.85" opacity="0.9"/>
      </g>
    </svg>
  `;
  return frame;
}

/** Rider-Waite style face: cream mat, framed art, centered caption strip below. */
function buildFavoriteFace(
  kind: "front" | "back",
  artContent: HTMLElement,
  titleEl: HTMLElement | null,
  badgeEl: HTMLElement | null,
): HTMLElement {
  const face = document.createElement("div");
  face.className = `card-face card-${kind}`;

  const mat = document.createElement("div");
  mat.className = "card-mat";

  const art = document.createElement("div");
  art.className = "card-art";
  art.appendChild(artContent);
  art.appendChild(makeCardFrame());
  if (badgeEl) art.appendChild(badgeEl);
  mat.appendChild(art);

  if (titleEl) {
    titleEl.classList.add("card-caption");
    mat.appendChild(titleEl);
  } else {
    const spacer = document.createElement("div");
    spacer.className = "card-caption card-caption-spacer";
    spacer.setAttribute("aria-hidden", "true");
    mat.appendChild(spacer);
  }

  face.appendChild(mat);
  return face;
}

function fillCover(coverWrap: HTMLElement, game: GameEntry) {
  const coverHost = document.createElement("div");
  coverHost.className = "game-cover placeholder";
  coverHost.textContent = "No art";
  coverWrap.appendChild(coverHost);

  if (game.coverPath) {
    void coverUrl(game.coverPath).then((url) => {
      if (!url) return;
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
}

function bindTileActions(tile: HTMLElement, game: GameEntry, index: number) {
  tile.addEventListener("click", () => {
    if (carouselSuppressClick) return;
    if (isHorizontalBrowse() && index !== focusIndex) {
      setFocusedTile(index);
      return;
    }
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
}

function createGameTile(game: GameEntry, index: number): HTMLElement {
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
  fillCover(coverWrap, game);
  tile.appendChild(coverWrap);
  bindTileActions(tile, game, index);
  return tile;
}

function createDeckWallCard(game: GameEntry): HTMLElement {
  const card = document.createElement("div");
  card.className = "deck-wall-card";
  card.dataset.path = game.path;
  const coverWrap = document.createElement("div");
  coverWrap.className = "game-cover-wrap";
  fillCover(coverWrap, game);
  card.appendChild(coverWrap);
  return card;
}

function renderHeroDeck(grid: HTMLElement) {
  const deckWall = document.createElement("div");
  deckWall.className = "deck-wall";
  deckWall.setAttribute("aria-hidden", "true");
  for (const game of visibleGames) {
    deckWall.appendChild(createDeckWallCard(game));
  }

  const heroStage = document.createElement("div");
  heroStage.className = "hero-stage";
  heroStage.addEventListener("click", () => {
    if (carouselSuppressClick) return;
    const game = visibleGames[focusIndex];
    if (game) void launch(game.path);
  });

  const cardHand = document.createElement("div");
  cardHand.className = "card-hand";
  visibleGames.forEach((game, index) => {
    cardHand.appendChild(createGameTile(game, index));
  });

  grid.appendChild(deckWall);
  grid.appendChild(heroStage);
  grid.appendChild(cardHand);
  syncHeroStage();
  ensureFocusVisible();
  requestAnimationFrame(() => {
    const tile = grid.querySelector<HTMLElement>(`.game-tile[data-index="${focusIndex}"]`);
    revealFocusedTile(tile);
  });
}

function renderGrid() {
  const grid = gridEl();
  visibleGames = filteredGames();
  grid.innerHTML = "";

  updateEmptyState(visibleGames.length > 0);
  if (!visibleGames.length) {
    ambientGen += 1;
    resetAmbient();
    return;
  }

  if (isHeroDeckLayout()) {
    renderHeroDeck(grid);
    return;
  }

  const favorites = isFavView();
  if (favorites) {
    grid.appendChild(makeFateSpan("lead", 0));
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
    fillCover(coverWrap, game);

    if (favorites) {
      const titleEl = coverWrap.querySelector<HTMLElement>(".game-title");
      const badgeEl = coverWrap.querySelector<HTMLElement>(".fav-badge");
      titleEl?.remove();
      badgeEl?.remove();

      const stage = document.createElement("div");
      stage.className = "card-stage";
      const flipper = document.createElement("div");
      flipper.className = "card-flipper";
      flipper.appendChild(buildFavoriteFace("front", coverWrap, titleEl, badgeEl));
      flipper.appendChild(buildFavoriteFace("back", makeTarotBack(), null, null));
      stage.appendChild(flipper);
      tile.appendChild(stage);
    } else {
      tile.appendChild(coverWrap);
    }

    bindTileActions(tile, game, index);
    grid.appendChild(tile);

    if (favorites && index < visibleGames.length - 1) {
      grid.appendChild(makeFateSpan("gap", index + 1));
    }
  });

  if (favorites) {
    grid.appendChild(makeFateSpan("tail", visibleGames.length + 1));
    updateFavoriteFan();
  }

  ensureFocusVisible();
  if (favorites) {
    requestAnimationFrame(() => {
      const tile = grid.querySelector<HTMLElement>(`.game-tile[data-index="${focusIndex}"]`);
      revealFocusedTile(tile);
    });
  }
}

function render() {
  syncFavoritesMode();
  renderCategories();
  renderGrid();
}

function ensureFocusVisible() {
  if (!visibleGames.length) return;
  setFocusedTile(focusIndex);
}

function columnsEstimate(): number {
  if (isHorizontalBrowse()) return 1;
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

function resolveLayout(themeName: string): "default" | "ornate-grid" | "hero-deck" {
  if (themeName === "ornate-grid" || themeName === "hero-deck") return themeName;
  return "default";
}

async function applyTheme(name: string) {
  activeLayout = resolveLayout(name);
  shellEl().dataset.layout = activeLayout;
  document.documentElement.dataset.layout = activeLayout;
  try {
    const css = await invoke<string>("get_theme_css", { name });
    themeStyleEl.textContent = css;
  } catch {
    themeStyleEl.textContent = "";
  }
}

function themeLabel(name: string): string {
  return THEME_LABELS[name] ?? name;
}

function pickInitialCategory(lib: LibrarySnapshot) {
  if (pickedInitialCategory) return;
  pickedInitialCategory = true;
  const byPath = new Set(lib.games.map((g) => g.path));
  if (lib.favorites.some((p) => byPath.has(p))) {
    activeCategory = "favorites";
  }
}

async function loadLibrary() {
  snapshot = await invoke<LibrarySnapshot>("get_library");
  await applyTheme(snapshot.theme);
  pickInitialCategory(snapshot);
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
    opt.textContent = themeLabel(theme);
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

function nearestBrowseIndex(): number {
  const scroller = browseScrollEl();
  const mid = scroller.scrollLeft + scroller.clientWidth / 2;
  let best = 0;
  let bestDist = Infinity;
  scroller.querySelectorAll<HTMLElement>(".game-tile").forEach((tile) => {
    const index = Number(tile.dataset.index ?? 0);
    const center = tile.offsetLeft + tile.offsetWidth / 2;
    const dist = Math.abs(center - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return best;
}

function moveFocus(dx: number, dy: number) {
  if (!visibleGames.length) return;
  if (isHorizontalBrowse()) {
    if (dx === 0) return;
    setFocusedTile(focusIndex + dx);
    return;
  }
  const cols = columnsEstimate();
  const next = focusIndex + dx + dy * cols;
  setFocusedTile(next);
}

function bindFavoritesChrome() {
  const grid = gridEl();
  let drag: { pointerId: number; startX: number; startLeft: number; moved: boolean } | null =
    null;

  const scrollerForEvent = () => browseScrollEl();

  grid.addEventListener("pointerdown", (e) => {
    if (!isHorizontalBrowse() || e.button !== 0) return;
    const scroller = scrollerForEvent();
    drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startLeft: scroller.scrollLeft,
      moved: false,
    };
    carouselDragging = false;
    carouselSuppressClick = false;
    grid.setPointerCapture(e.pointerId);
  });

  grid.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const scroller = scrollerForEvent();
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 8) {
      drag.moved = true;
      carouselDragging = true;
      carouselSuppressClick = true;
    }
    if (drag.moved) {
      scroller.scrollLeft = drag.startLeft - dx;
    }
  });

  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = drag.moved;
    drag = null;
    carouselDragging = false;
    if (moved && isHorizontalBrowse()) {
      setFocusedTile(nearestBrowseIndex());
      window.setTimeout(() => {
        carouselSuppressClick = false;
      }, 50);
    } else {
      carouselSuppressClick = false;
    }
  };
  grid.addEventListener("pointerup", endDrag);
  grid.addEventListener("pointercancel", endDrag);

  grid.addEventListener(
    "wheel",
    (e) => {
      if (!isHorizontalBrowse()) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      scrollerForEvent().scrollLeft += e.deltaY;
    },
    { passive: false },
  );

  let scrollSnapTimer = 0;
  const snapCarousel = () => {
    if (!isHorizontalBrowse() || carouselDragging || !visibleGames.length) return;
    const nearest = nearestBrowseIndex();
    if (nearest !== focusIndex) setFocusedTile(nearest);
  };
  const onScroll = () => {
    if (!isHorizontalBrowse() || carouselDragging) return;
    window.clearTimeout(scrollSnapTimer);
    scrollSnapTimer = window.setTimeout(snapCarousel, 140);
  };
  grid.addEventListener("scroll", onScroll, true);
  grid.addEventListener("scrollend", snapCarousel, true);

  window.addEventListener("resize", () => {
    if (!isHorizontalBrowse() || !visibleGames.length) return;
    const tile = grid.querySelector<HTMLElement>(`.game-tile[data-index="${focusIndex}"]`);
    if (isHeroDeckLayout()) syncHeroStage();
    revealFocusedTile(tile);
  });
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
  document.querySelector("#btn-close")?.addEventListener("click", () => {
    void invoke("hide_window");
  });
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
    pickInitialCategory(snapshot);
    render();
  });

  await listen<boolean>("open-settings", (event) => {
    if (event.payload) void openSettings();
  });

  await loadLibrary();
  bindFavoritesChrome();
  requestAnimationFrame(pollGamepad);
  gridEl().focus();
});
