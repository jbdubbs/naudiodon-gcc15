# PortAudio patches

This directory documents source-level patches applied to PortAudio before
building the prebuilt `libportaudio.so.2` checked into `portaudio/bin/`
(and `portaudio/bin_arm64/`, `portaudio/bin_armhf/` where noted). Naudiodon
itself never compiles PortAudio — `binding.gyp` links directly against the
checked-in prebuilt library — so these patches only take effect when that
binary is rebuilt.

## 0001-initializehostapis-skip-failed-hostapi.patch

**Base:** upstream `github.com/PortAudio/portaudio`, commit `375345a`
(same commit this fork's `libportaudio.so.2` was already built from as of
the "rebuild libportaudio with PulseAudio support" change — see that
commit's message for the original build recipe).

**Bug:** `InitializeHostApis()` in `src/common/pa_front.c` aborts the
*entire* `Pa_Initialize()` call if **any single** host API's `Initialize()`
returns a non-`paNoError` result (`if (result != paNoError) goto error;`).
Individual ALSA *devices* that can't be probed are already skipped
gracefully further down the stack (`pa_linux_alsa.c`'s `FillInDevInfo`
discards a `GropeDevice()` failure and just excludes that one device — this
has been true since PortAudio's very first commit), but there was no
equivalent tolerance one level up, across host APIs.

This bites hard now that this fork's build enables the PulseAudio host API
(`--with-alsa`, PulseAudio auto-detected) alongside ALSA, for PipeWire
device-routing convenience. In a minimal/containerized environment that
only bind-mounts raw ALSA device nodes (`/dev/snd`) with no PulseAudio/
PipeWire runtime socket reachable (eg. a headless Docker deployment), the
PulseAudio host API's own `Initialize()` fails outright — and takes the
otherwise-perfectly-fine ALSA host API down with it. The result: `naudiodon
.getDevices()`/`getHostAPIs()` throw `"Could not initialize PortAudio:
Unanticipated host error"` and return **zero devices at all**, even though
real, usable ALSA hardware (eg. a USB radio audio interface) is present and
would enumerate fine on its own.

Confirmed by a single-variable local repro: pointing `PULSE_SERVER`/
`XDG_RUNTIME_DIR` at a nonexistent socket path reproduces the failure
exactly; restoring a normal PipeWire/PulseAudio session fixes it — with the
*exact same* ALSA hardware and the *exact same* per-device `GropeDevice`
warning present (and harmlessly swallowed) in both cases. The PulseAudio
socket's reachability, not any ALSA device quirk, is what flips the result.

**Fix:** when a host API initializer fails, log it, mark that slot `NULL`,
reset `result` to `paNoError`, and `continue` the loop instead of `goto
error`. Each host API's own `Initialize()` is already responsible for
cleaning up its own partial allocations before returning an error (see
`PaAlsa_Initialize`'s `error:` label), so no extra cleanup is needed here.
A host API that fails to initialize simply doesn't appear in
`getHostAPIs()`'s result — exactly like a host API that was never compiled
in at all.

**Build:** `./configure --without-jack --with-alsa && make`, inside an
`ubuntu:24.04` container (`PA_USE_ALSA=1 PA_USE_PULSEAUDIO=1 PA_USE_OSS=1`
confirmed in the build log — same configuration as the currently-shipping
binary). The container floor matches the downstream `rigcontrolweb`
project's own glibc 2.39 baseline; confirmed via
`objdump -T lib/.libs/libportaudio.so.2.0.0 | grep -oP 'GLIBC_\K[0-9]+\.[0-9]+' | sort -V | tail -1`
→ requires glibc ≤ 2.34, under the 2.39 floor.

**Verification:** swapped the rebuilt `.so` into a local naudiodon install's
`build/Release/libportaudio.so.2` (where the compiled addon's `RUNPATH`
actually resolves it from — not just `portaudio/bin/`) and re-ran the
PulseAudio-unreachable repro above. Before the patch: `getHostAPIs()`/
`getDevices()` both throw. After: `getHostAPIs()` returns ALSA (bad device
correctly excluded, good ones present) and OSS (0 devices, as before);
PulseAudio is cleanly absent from the list instead of crashing everything.
`getDevices()` returns the full ALSA device set successfully.

**Scope of this pass:** only the Linux x64 binary (`portaudio/bin/
libportaudio.so.2`) was rebuilt with this patch. `pa_front.c` is
platform-agnostic (`src/common/`), so the same fix should be applied when
`portaudio/bin_arm64/`, `portaudio/bin_armhf/`, and the Windows/macOS
binaries are next rebuilt — no mingw/macOS toolchain was available in the
environment this patch was produced in to do those in the same pass.
