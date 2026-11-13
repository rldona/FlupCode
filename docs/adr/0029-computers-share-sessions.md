# ADR-0029: The user's computers see each other's sessions

- **Status:** Accepted. Steps 1 (the desktop app as a remote client) and 2 (every computer's
  sessions in one sidebar) are implemented; step 3 is planned.
- **Date:** 2026-11-13
- **Amends:** [ADR-0010](0010-remote-control-relay.md)

## Context

The user works on two computers, a Mac and an Ubuntu PC, each running the FlupCode desktop app. The
two instances do not know each other: a session started on the Mac cannot be seen or continued from
the PC.

ADR-0010 already moves a session's traffic between devices: a desktop is a **host**, a phone pairs
with it through the relay and drives its engine over an end-to-end encrypted tunnel. The web client
can keep several paired hosts. The desktop app, however, is only a host: `remote.ts` returns early
on `desktopRemote()`, so a desktop window can never drive another computer.

The experience we want is the one Claude Desktop gives with Remote Control: the other computer's
sessions appear in the sidebar, inside their project, with a computer icon; opening one drives it on
the computer it lives on, and messages show up live on both screens. When that computer is offline
its sessions stay listed and say that remote control is unavailable.

## Decision

Sessions are **not copied or synchronised**. A session lives in the engine of the computer that
created it, and every other computer reaches it through the relay, as a phone does. Both screens
read the same engine and subscribe to the same event stream, so what one types appears on the other
with no extra work, and a permission answered on one disappears from the other.

Rejected alternatives:

- **Synchronising the engines' databases.** It writes into the engine's storage behind its back
  (against ADR-0027), conflicts when both sides write, and breaks whenever the engine changes its
  schema.
- **Handing a session over** (`session.export` on one engine, `session.import` on the other). Useful
  later to *move* a session, but paths differ between computers and the repository state does not
  travel with it. It can be built on top of this channel if it is ever needed.

The work lands in three steps:

1. **The desktop app is also a remote client** (this change). A desktop window can pair with
   another computer and drive it exactly as the web client does: the whole window switches to that
   engine, and "Disconnect" brings it back to the local one. A desktop cannot scan a QR code, so the
   remote control panel accepts a pasted pairing link. The window's own host keeps running: the Mac
   can drive the PC while a phone drives the Mac.
2. **Every computer's sessions in one sidebar.** An engine on another computer has an address of its
   own, `https://<host>.remote.flupcode.invalid`, and every engine call goes to the computer its
   address names (`transport.ts`), so the window can reach several engines at once. The desktop app
   keeps a background link to each paired computer it is not driving, lists that computer's
   sessions through it and keeps the list current from that computer's own event stream
   (`features/sessions/elsewhere.ts`). The sidebar shows them beside its own, with a computer icon;
   the last list seen from each computer is kept, so an offline computer's sessions stay listed,
   dimmed, as unavailable.
   The window still drives **one engine at a time**: opening another computer's session moves the
   window to that engine (as in step 1), and opening one of this computer's moves it back. The
   model picker, permissions, questions and the transcript's live stream then all belong to the
   same engine, with no per-call bookkeeping in the many stores that read it. A session on an
   engine the window is not driving can only be opened from the sidebar: renaming, deleting or
   starting a session there would reach the wrong engine.
3. **Projects across computers.** One folder has a different path on each computer
   (`/Users/…` and `/home/…`). A remote session is grouped under the local project with the same
   `git remote` URL, then the same folder name, and otherwise under a group named after the
   computer.

## Consequences

- Nothing new on the relay or in the secure channel: pairing, device keys, revocation and the
  tunnel are ADR-0010's.
- While a desktop window drives another computer, the features that act on *this* machine are off:
  opening files in local apps, the native folder picker, the preview of local dev servers and the
  local engine's status banner. Paths in the transcript belong to the other computer.
- The packaged renderer's Content-Security-Policy only allows the configured relay, so a desktop
  can only pair with computers that use the same relay.
- Only what the engine holds is shared. What FlupCode keeps on each computer (drafts, open tabs,
  `harness.sqlite`: tasks, memory) stays local.
- The other computer must be on with the FlupCode desktop app open (or `flupcode remote`) and
  remote control turned on.
