# 🎰 Play-Along Live

**Free giveaway picker for any live MyPrize room. No signup. No setup. No install.**

Open the page → pick your live room (say, SlothHopper mid-stream) from the dropdown → entries collect
automatically from play-along rounds → draw a winner with a big-screen
animation. That's the whole thing.

- **Zero backend** — runs entirely in your browser off MyPrize's public API.
  Nothing is stored anywhere except your own browser (localStorage).
- **Fair draws** — crypto-random, optionally weighted by rounds played.
- **OBS-friendly** — full-screen winner moment with scrolling name columns.

> Entries count play-along *participation* (public data can't split SC/GC
> per player). Every player in a completed round = one entry.

## Host it yourself
It's three static files. Fork → Settings → Pages → deploy from branch. Done.

Built by **WebWizardWill** for the streamer fam 💝

## Streamer links, OBS dock + overlay

**Your own link.** Pick your room once and hit **🔗 Copy my link** — you get
`?r=yourname`, which opens straight into your room with your name, avatar and
live status on it. No room picker, and the link keeps working while you're offline.

**On stream.** Add two browser views *inside OBS* — both must be in OBS so they
share a browser profile:

| What | URL | Where in OBS |
|---|---|---|
| Overlay | `?r=yourname&obs=1` | **Browser Source** (transparent) |
| Controls | `?r=yourname&dock=1` | **Docks → Custom Browser Dock** |

The dock collects entries and draws; the overlay performs the reveal. They sync
through the browser's own storage — which is why a dock in a separate Chrome
window will *not* reach the overlay. Keep both in OBS.

## Live window

Entries only count for a rolling window — 5, 10, 15, 30 min or 1 hour. Keep
playing and you stay in; stop and you age out. There is deliberately no
"all time": a draw is for the people who are actually still in the room. The
page shows the clock time of the oldest spin still counting, so you can say it
out loud without doing the maths live.

Spin speed (slow / normal / fast) sets how long the drum roll runs. Fast by default.
