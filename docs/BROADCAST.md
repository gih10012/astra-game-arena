# OBS live and replay output

## Program page

`http://127.0.0.1:4317/live` is the only source an OBS scene needs. Configure
it as a 1920×1080 Browser Source and enable OBS's **Control audio via OBS**
option. The Web page includes the image, the private game audio, mode labels,
and transitions; the implementation endpoints are not separate OBS inputs.

The watchdog owns the page and media routes, so it remains reachable when no
challenge is active. It never opens a window on the physical compositor.

## Automatic decisions

The default `auto` mode uses the live director and the run-local game audio
only while an intact challenge worker is in `running`. It can use the selected
replay playlist during these configurable states:

- no active challenge (`idle`, on by default);
- model quota wait (`waiting_quota`, on by default);
- operator pause;
- low-power wait; or
- retry wait.

Quota replay visibly shows both a replay badge and the expected reset timestamp
from the durable run checkpoint. A forced mode is useful for an intermission or
for checking a live scene before a broadcast. Forced live displays truthful
standby output when no live challenge exists; it does not relaunch a game.

## Replay library and persistence

The control page automatically indexes completed production files and sealed
challenge parts below `runs/`, plus files placed in
`.arena/broadcast-media/`. An operator may add another existing video by
absolute path. Adding a path does not copy, modify, or delete that file.

The ordered selection and all live settings are durably written to
`.arena/broadcast-config.json`, which is local and ignored by Git. The replay
route only accepts opaque IDs that are currently selected; arbitrary path
queries are rejected. FFmpeg reads each item at normal playback speed and
server-decodes its picture into a continuous MJPEG stream. Audio, when present,
is separately encoded as Opus inside the same page. OBS still receives both
through its single Browser Source; silent source files remain silent.

## Audio isolation

During a live challenge, `/live` contains a hidden HTML audio player connected
to the challenge's run-specific PipeWire/PulseAudio sink monitor. It contains
the game audio only—not the physical microphone or ordinary desktop audio.
The normal control-page preview is deliberately muted to avoid feedback; this
does not mute the OBS program page. The broadcast audio checkbox and volume
setting apply immediately without pausing the game or Codex.

Replay pictures are ordinary MJPEG `<img>` frames, so Chromium never invokes its
hardware video decoder or overlay plane. This keeps the program picture visible
in Edge, OBS, and Wayland captures even on affected GPU drivers. Playlist timing
comes from server-side media metadata; interrupted streams reconnect, and a
reconnected control-plane event rebuilds them after service restart.

The optional V4L2 virtual camera and `Astra Game Microphone` remain available
for meeting applications, but OBS does not need them when it uses `/live`.
