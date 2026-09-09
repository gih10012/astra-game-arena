# Continuity and recovery guarantees

The arena's exact-resume primitive is deliberately simple: keep the same
challenge worker and native game alive in an independent user-systemd cgroup,
and freeze the run-marked Steam/Proton/Wine/game process tree with `SIGSTOP`
during quota, low-power, and operator waits. The private compositor and
controller stay responsive so the frozen frame remains observable; resume
sends `SIGCONT` to those same PIDs. A durable JSON
checkpoint, game save, or JPEG can help audit a run, but none contains Wine
memory, CPU state, Vulkan/DirectX state, or GPU allocations. The project never
labels reconstruction from those files as an exact resume.

## Event guarantees

| Event | Exact game-state continuity | Arena behavior |
| --- | --- | --- |
| Watchdog or Web restart | Yes | The independent challenge-worker cgroup is untouched; its PID tree remains live. |
| Quota, account, low-power, or operator pause | Yes | The marked game PID tree is frozen; Codex, active timing, recording, camera, and game microphone stop. Resume starts the next outputs on the frozen live frame, then thaws the same PIDs. |
| Normal system suspend/resume | Conditional | The kernel freezes the same process image. Continuity holds when platform firmware and the GPU driver suspend and resume successfully. |
| Whole-host hibernation/resume | Conditional | It can bridge power-off only when swap/image capacity, resume configuration, initramfs, firmware, storage, and GPU restoration have all been configured and tested on that host. |
| Challenge worker/game crash, ordinary reboot, failed hibernation, or hard power loss | No | The run is left paused with an explicit continuity error. Automatic cold launch is forbidden. |

Consequently, a last-frame JPEG is an audit frame, not a holding screen used to
hide a title page. An adapter save is a useful artifact, not proof that the
same in-memory execution resumed. If exact state has been lost, the operator
must end the run and start a new challenge rather than splice a relaunch into
the old run.

## Suspend and hibernation boundary

The Linux kernel distinguishes suspend-to-idle/suspend-to-RAM from hibernation.
Suspend retains system state in memory; hibernation writes a system-memory
image to persistent storage and restores it through a fresh kernel boot. See
the official [Linux sleep-states documentation](https://cdn.kernel.org/doc/html/latest/admin-guide/pm/sleep-states.html).

The arena does not enable hibernation, resize swap, modify an initramfs, or
change firmware/driver settings. Those are host-wide operations and must be
validated outside a formal run. Merely exposing `disk` in `/sys/power/state`
does not prove that resume is configured or that a particular game/GPU stack
will recover.

NVIDIA documents separate suspend/hibernate integration and preservation of
video-memory allocations, with behavior depending on driver flavor and system
configuration. Review and test the official
[NVIDIA power-management guidance](https://download.nvidia.com/XFree86/Linux-x86_64/595.84/README/powermanagement.html)
before relying on host sleep for a GPU game. A successful one-cycle test is not
a guarantee against firmware, driver, storage, or power failures, so raw video
parts and audit events remain authoritative.

## Why this is not an application snapshot

A complete virtual-machine snapshot can include CPU state, RAM, device state,
and writable disks, as described by the official
[QEMU snapshot documentation](https://www.qemu.org/docs/master/system/images.html).
That is a different architecture from this arena, which runs the game natively
inside a private compositor. Even a VM does not make arbitrary passed-through
GPU state portable: QEMU's
[VFIO migration documentation](https://www.qemu.org/docs/master/devel/migration/vfio.html)
requires migration support and state handling from the device and driver.

The arena therefore does not use CRIU, a save file, or a frozen screenshot as
a generic substitute for native game and GPU process state. Supporting another
game does not weaken this rule.

## Recording boundary

The first recording begins on the real initial game view. Quota, power, and
operator pauses seal the current part only after their real capture boundary;
resumption creates the next part from the same retained game. The assembler
normalizes timestamps and concatenates sealed parts, but does not trim loading
or title screens to disguise a relaunch. If the process was lost, no new part
is recorded under that run.

Normal suspend gaps are excluded from active challenge time and from generated
frame-count timestamps. Watchdog/Web restarts create no game or media boundary
because they do not own the challenge cgroup.

## Virtual camera and game-only microphone

When the virtual-output switch is enabled, the arena publishes the director
layout to the selected V4L2 loopback camera and creates an `Astra Game
Microphone` source. The private game is routed to a dedicated PipeWire sink;
the source monitors that sink, so it excludes the physical microphone and
ordinary desktop applications. Disabling the virtual output removes the
published microphone source while keeping game-audio routing private.

This design follows PipeWire's documented loopback model for virtual sinks and
sources. See the official [`pw-loopback` manual](https://docs.pipewire.org/page_man_pw-loopback_1.html)
and [loopback-module documentation](https://docs.pipewire.org/1.2/page_module_loopback.html).
OBS, meeting clients, and other applications choose the camera and microphone
as separate devices.
