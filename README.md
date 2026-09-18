# Alan Games Launcher

Lightweight game launcher for ROG Ally X (and any Windows display). Drop `.lnk` / `.url` shortcuts into a watched folder, browse cover art, and launch games quickly — then the app stays in the tray.

## Features

- Watches `%USERPROFILE%\AllyLauncher\Games` (configurable)
- Categories: **All**, **Favorites** (hero carousel), **Recent**, plus subfolders
- Cover art from [SteamGridDB](https://www.steamgriddb.com/) with local disk cache
- Touch, mouse, and gamepad navigation
- Optional launch on Windows startup
- Custom CSS themes via `%APPDATA%\ally-launcher\themes\*.css`

## Setup

### Prerequisites

- Windows 10/11
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (MSVC toolchain)
- WebView2 (usually preinstalled on Windows 11 / Ally)

### Install & run

```bash
npm install
npm run tauri dev
```

Build a release binary:

```bash
npm run tauri build
```

### SteamGridDB API key

1. Create a key at SteamGridDB.
2. Open **Settings** in the app and paste it, **or** edit:

`%APPDATA%\ally-launcher\config.json`

See [`config.example.json`](config.example.json) for the shape. Never commit your real key.

**Security:** If a key was shared in chat or committed by mistake, rotate it on SteamGridDB.

### Games folder

Default: `C:\Users\<you>\AllyLauncher\Games`

- Put shortcuts (`.lnk`) or Steam internet shortcuts (`.url`) here
- Subfolders become category tabs

## Controls

| Input | Action |
| --- | --- |
| Tap / click | Launch (on Favorites, a side card selects first) |
| Long-press / right-click / **Y** | Favorite |
| D-pad / stick / arrows | Move (Favorites is left/right only) |
| **A** / Enter | Launch |
| **LB** / **RB** / `[` `]` | Change category |
| **Start** | Settings |
| **B** / Esc | Close settings / hide to tray |

## CSS theme hooks

Built-in themes (Settings → Theme):

- **Default** — classic portrait grid
- **Ornate grid** — filigree card frames + stronger deck tilts
- **Hero deck** — large chosen card, dense deck wall, hand strip

Favorites always uses the tarot table-spread layout (arc, felt wash, fate threads), regardless of theme.

Themes can override CSS variables and classes:

- Variables: `--bg`, `--bg-glow`, `--bg-elevated`, `--text`, `--text-muted`, `--accent`, `--accent-soft`, `--tile-gap`, `--tile-radius`, `--title-size`, `--bar-height`, `--focus-ring`, `--touch-min`, `--font`, `--scrollbar-thumb`, `--fav-thread`, `--fav-thread-gold`
- Classes: `.app-shell`, `.top-bar`, `.brand`, `.category-bar`, `.category-tab`, `.game-grid`, `.game-tile`, `.game-cover`, `.game-title`, `.fav-badge`, `.settings-dialog`, `.icon-btn`, `.icon-btn-tool`, `.primary-btn`, `.controls-hint`
- Layout hooks: `[data-layout="default"|"ornate-grid"|"hero-deck"]`, `.hero-deck`, `.hero-stage`, `.hero-card`, `.deck-wall`, `.card-hand`
- Favorites-only: `[data-category="favorites"]` on `.app-shell` / `.game-grid`, `.fav-carousel`, `.card-stage`, `.card-flipper`, `.tarot-back`, `.fate-span`, `.fate-string`, `.fate-bead`, `.empty-favorites`

Example theme: [`themes/example.css`](themes/example.css) — copy into the app themes folder (Settings → Open themes folder).

## Architecture

- **Tauri 2** Rust backend: folder watcher, launch, config, SteamGridDB, startup toggle, tray
- **Vite + TypeScript** frontend: adaptive grid UI

App data lives under `%APPDATA%\ally-launcher\` (`config.json`, `covers/`, `themes/`). Config writes are atomic and a `config.json.bak` is kept so favorites and cover mappings survive interrupted saves.
