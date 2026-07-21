# Lightners Live — Web Edition

A browser recreation of the Godot “Lightners Live” (Deltarune Ch.3-style) rhythm game.

## Running it

Browsers block audio/MIDI `fetch()` requests from `file://` pages, so don’t just
double-click `index.html`. Instead, serve the folder over local HTTP:

```
cd Lightners-Live-Web
python3 -m http.server 8080
# then open http://localhost:8080 in your browser
```

or upload the whole folder to any static host (GitHub Pages, Netlify, Vercel, etc).

## What’s included

- 3 built-in songs (Raise Up Your Bat, ASGORE, Hopes and Dreams) with their original
  charts and audio, ported straight from the Godot project’s MIDI files.
- A from-scratch in-browser MIDI parser — no external libraries — so **custom maps**
  work: upload any `.mid` chart + audio file pair from the menu’s “Custom Map” box.
  Charts must use the same note-number convention as the original project:
  - `38` = left tap, `36` = right tap, `39` = left hold, `35` = right hold
- All original sprites (background, Kris/Susie/Ralsei, notes, rhythm board, hit FX)
  sliced out of the source atlases and used directly.
- Keyboard controls matching the original: Left = arrows-left/Z/A/F/S, Right = arrows-right/X/D/J/K,
  hold R to restart, Esc to pause.
- Mobile/touch controls: two large semi-transparent buttons splitting the screen
  down the middle for left/right, plus on-screen pause/restart buttons.

## Project structure

```
index.html          entry point
style.css            all styling
js/midi.js           MIDI parser + chart builder
js/game.js           game engine (rendering, input, scoring, menus)
assets/sprites/      individual sprite frames sliced from the original atlases
assets/audio/        song audio + charts, and hit sound effects
assets/fonts/        the Deltarune-style font used in the original
```

Not affiliated with Toby Fox or the original “Lightners Live Plus” project.
