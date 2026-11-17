# Third-party code

Driftboard is licensed GPL-3.0-only. List every adapted file here: source repo, commit, file, license.

| Source repo | Commit | Files | License | Used in |
|---|---|---|---|---|
| Lightricks/LTX-Desktop | d23b8b3 | frontend/views/editor core (15 files, copied unmodified to packages/editor/src/ltx, see its NOTICE.md) | Apache-2.0 | `editor` |

Patterns re-implemented in our own code (no files copied), credit kept here: IV Studio `llm.js` (the json_schema, json_object, plain-text ladder and remembering what a server accepts; MIT) and OpenField `shotlist.ts` (forgiving JSON repair and snapping free-text answers to allowed options; MIT) in `packages/adapter-llm`.

Guides: `guides/h3-video.md` is the project owner's own MiniMax H3 prompt-enhancer text (v1.1), edited only for the duration rule; the other guides are written for this project.

Bundled binaries: ffmpeg (GPL build, via ffmpeg-static, GPL-3.0-or-later), better-sqlite3 (MIT), Electron (MIT).

Runtime libraries used by the editor package: zod (MIT), zustand (MIT), lucide-react (ISC), use-sync-external-store (MIT), React (MIT), @xyflow/react (MIT).

ffmpeg source: the bundled ffmpeg.exe is the gyan.dev "essentials" GPL build (via the `ffmpeg-static` npm package). Its corresponding source code is available from https://ffmpeg.org/download.html and https://www.gyan.dev/ffmpeg/builds/.
