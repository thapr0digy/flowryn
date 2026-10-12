# A concise README

- Status: done

README.md went from 231 lines (~5.5k words) to about 120 lines (~950 words). Its job is now one thing: a new user can install, set up and run Flowryn from it.

Kept:

- What Flowryn is, in one paragraph.
- Install (requirements, build, link) and set up (`init`, `doctor`, `doctor --contracts`, `project add`, the GitHub token, reinstalling the launchd agent after moving the binary).
- The core verbs: `lead`, `dispatch`, `fleet`, `show`, `steer`, `board`, `approve`, `merge`, `cleanup`, `help`.
- The "Development" and "Running the M0 spikes" headings, which AGENTS.md and `docs/m0-verdicts.md` point at.

Moved or cut:

- The per-milestone Status section: one line pointing at `docs/v1-status.md`.
- The long verb list: `flowryn help` and `flowryn <verb> --help` print every verb.
- The configuration paragraph: each key is already explained in the milestone notes or its `docs/notes/` file, and `bun run notes` lists the keys.
- The worker verbs and the contract-check policy: the notes and the verbs' own help cover them.
- The M2–M5, v1 and cutover live-run walkthroughs: a short list pointing at `scripts/lab/*-live.sh` and the matching notes, which record each run's phases and results.
- "Key choices": a list of links to `docs/design-v3.html`, `docs/m0-verdicts.md` and the notes.
- The source-layout paragraph: a pointer to section 4 of the design.

The frozen notes are unchanged. No code changed.
