# Hero Lectro F6i - Bluetooth protocol

Recovered from the official HeroLectro Android app v3.0 (com.hero.lectro,
April 2022), then corrected twice against live captures from a real F6i.
Controller: **Santroll**.

## GATT layout

Advertised device name: `F6i`. Service `FFB0` holds four characteristics:

| UUID   | Properties                         | Role |
|--------|------------------------------------|------|
| `FF03` | write, write-no-resp, notify       | chatters `01 01`; also greets with `02 02 02` / `01 0a` on connect |
| `FF04` | read, write, write-no-resp, notify | readable, purpose unknown |
| `FFB1` | write, notify                      | the bike answers here |
| `FFB2` | write-no-resp, notify              | **write the request here, and replies also arrive here** |

## The bike never speaks unsolicited

Subscribing gets you nothing. `BLEConnectionService$b.run()` in the original
app writes this request in a loop and sleeps:

```
46 11 10 00 3E 25
```

Stored as the literal string `"46 11 10 00 3E 25"` and converted by
`Lc/e/a/c/a;.A(String)`. 300 ms between polls works.

## Reply framing

**This is the part the app's byte offsets hid.** Replies are not fixed-offset
records. Each is:

```
46 11 10 | LEN | <tag,value> <tag,value> ... | CRC16-hi CRC16-lo
```

`LEN` counts only the tagged body, so the whole frame is `LEN + 6`.

A real full frame, bike parked and charging:

```
46 11 10 19 20 00 00 21 80 07 22 0d 40 23 00 8c
24 00 00 00 26 00 27 01 28 23 80 00 00 61 43
```

**CRC-16/CCITT**, poly `0x1021`, init `0x0000`, no reflection, no final xor,
computed over the *entire frame including the header*, trailer big-endian.
Same polynomial as the lookup table found in the app. Verified against every
frame in two independent captures.

### Fragmentation

BLE splits one reply across several notifications, unpredictably: 23+8, 22+9,
25+6, 27+4, 29+2, 24+7 have all been observed. **`FF03` sometimes fires
between the two halves of an `FFB2` reply**, so buffers must be kept per
characteristic - a shared buffer splices `01 01` into the middle of a frame.

Decoding a fragment as if it were a whole record is what produced the
phantom "controller error 34": `0x22` is the voltage *tag byte*, and 34 is
`0x22` in decimal, read as data at a shifted offset.

## Tags

| Tag    | Bytes | Meaning | Scale |
|--------|-------|---------|-------|
| `0x20` | 2 | speed | x0.1 km/h |
| `0x21` | 2 | current. High byte meaning UNKNOWN - see below | low byte x0.1 A |
| `0x22` | 2 | pack voltage | x0.01 V |
| `0x23` | 2 | remaining range | x0.1 km |
| `0x24` | 3 | front lamp, **throttle held**, assist level | one byte each |
| `0x26` | 1 | error code, `0` when healthy | raw |
| `0x27` | 1 | flickers `00`/`01` with no rider input - NOT reliable motor state | raw |
| `0x28` | 4 | first byte crept 0x23 -> 0x24 while charging - unknown | raw |

`0x24` byte 1 is the **throttle**, not walk mode. In a throttle test it held `1`
for six continuous seconds while the throttle was twisted, and an earlier build
that labelled it "walk" made twisting the throttle light up a walk indicator.
Bytes 0 and 2 (lamp, assist level) are confirmed by toggling each on the bike
and watching only that byte change.

An earlier reading of `0x27` as a motor-inhibit flag was **wrong**. It was based
on a single window where it happened to read `00` during a motor cut; a longer
capture shows it flickering `01/00/01/00` with the bike stationary and untouched.
Its meaning is unknown.

### Assist 0 disables the motor entirely

With `0x24` byte 2 at `0`, the controller will not drive - throttle included.
A capture of the throttle held for six seconds at assist 0 shows speed pinned at
0.0 km/h and current never rising above 1.0 A, which is just the electronics.
Any client that wants the motor to work must set an assist level of 1 or higher.

## Charging is not directly reported

The high byte of tag `0x21` is **not understood**. An early guess that `0x80`
meant "current is flowing" was disproved by a capture where the largest current
in the whole log, 2.7 A under motor load, carried high byte `0x00` while every
idle 0.5-0.7 A sample carried `0x80`. It stays `0x80` with the charger plugged
in, so it is certainly **not** a charge/discharge flag - the original app's `batteryCurrentPostiveNegative`
field name is misleading. Current stays at 0.2-1.2 A, which is the controller's
own electronics; the charger feeds the pack directly and bypasses the shunt, so
charge current never appears.

Charging *is* detectable indirectly: pack voltage climbing steadily while the
bike is stationary. A real capture showed 33.92 -> 33.93 -> 33.95 V with range
14.0 -> 14.4 km over about 45 seconds.

## Connecting cuts motor power

**Opening a BLE connection inhibits the motor for a few seconds.** This is the
controller's own behaviour - it happens with the manufacturer's app too, so it
is not caused by anything a client sends.

Captured while holding the throttle at a steady 11.2 km/h and then connecting:

| time | speed km/h | current | `0x27` |
|------|-----------|---------|--------|
| connect | 11.2 | **2.7 A** | `00` |
| +0.5s | 11.0 | 0.5 A | `00` |
| +1s | 9.7 | 0.7 A | `00` |
| +2s | 8.0 | 0.5 A | `00` |
| +3s | 5.9 | 0.7 A | `00` |
| +4s | 5.9 | 0.7 A | **`01`** |

Motor current collapses from 2.7 A to idle immediately, the bike coasts down,
and `0x27` returns to `01` after roughly four seconds. That is what identifies
`0x27` as a motor-inhibit flag, and it is why the app refuses to connect
without a confirming second tap.

## Model and version packets

The app has parsers keyed on packet length (9 = version, 10-16 = model) reading
ASCII model codes from bytes 4-6 (`c3i`, `c5i`, `C5i E`, `C6i E`, `C8i`,
`KINZA-i`, `CLIX-i`, `F2i`, `F3i`, with **`f6i` as the fallback**). No such
packet has ever been seen from this bike - earlier "version packet: 128.0.0"
log lines were misparsed fragments, not real packets.

## Control commands

**The bike does accept control commands.** The app contains 15 command strings,
all of which validate against the same CRC-16/CCITT as the telemetry frames, so
these are genuine and not guesses. They share the frame format:

```
46 | A | B | LEN | payload | CRC16-hi CRC16-lo
```

| Command | Payload | Meaning |
|---------|---------|---------|
| `46 11 10 00 3E 25` | - | status poll (the one already in use) |
| `46 11 14 00 F2 E1` | - | request, sent once at connect - unidentified |
| `46 11 15 00 C1 D0` | - | request, sent once at connect - unidentified |
| `46 16 17 01 00 15 11` | `00` | binary toggle, off |
| `46 16 17 01 01 05 30` | `01` | binary toggle, on |
| `46 16 18 01 00 39 20` | `00` | mode: assist 0 |
| `46 16 18 01 01 29 01` | `01` | mode: assist 1 |
| `46 16 18 01 02 19 62` | `02` | mode: assist 2 |
| `46 16 18 01 03 09 43` | `03` | mode: assist 3 |
| `46 16 18 01 10 2B 11` | `10` | mode: walk |
| `46 16 18 01 80 A8 A8` | `80` | mode: assist 0 + lamp |
| `46 16 18 01 81 B8 89` | `81` | mode: assist 1 + lamp |
| `46 16 18 01 82 88 EA` | `82` | mode: assist 2 + lamp |
| `46 16 18 01 83 98 CB` | `83` | mode: assist 3 + lamp |
| `46 16 18 01 90 BA 99` | `90` | mode: walk + lamp |

### The 0x16 0x18 payload is a bitfield

```
bit 0x80 = front lamp on
bit 0x10 = walk mode
bits 0-3 = assist level (0..3)
```

Evidence: `BLEConnectionService.z` sends `...01 90` under the log label
`WALK_LAMP` and `...01 10` under `WALK_LAMP_OFF` - the two differ by exactly
`0x80`, and only by "LAMP" in the name. Builders `Lc/e/a/c/a;.T/P/Q/M/b0(Z)`
each take a boolean and return the same payload with or without `0x80`; the
boolean is `BLEConnectionService.g`, and `onMessageEvent` flips it with
`g = !g` then re-sends the current mode, which is the lamp toggle.

`BLEConnectionService.h` holds the assist level and selects the builder:
h=0 -> `b0` (walk), h=1 -> `P`, h=2 -> `Q`, h=3 -> `M`, h=4 -> `T`.

### How commands are sent

Commands are queued on `BLEConnectionService.e` (a `ConcurrentLinkedQueue`).
The polling thread drains one per tick, and falls back to the status poll when
the queue is empty. Each command is queued **twice** in the original app,
presumably for reliability against a dropped write.

### UI mapping

`DashboardActivity.onClick` posts EventBus codes that `onMessageEvent` turns
into commands: TOGGLE_MOTOR -> event 11, TOGGLE_LAMP -> event 12, plus
TOGGLE_ASSIST and TOGGLE_CRUISE. So the original app *did* ship these controls.

### Not yet identified

- `46 16 17` (the binary toggle) - sent during connect and in walk handling.
  Candidates are motor enable/disable or cruise control.
- `46 11 14` / `46 11 15` - zero-payload requests. Strong candidates for
  "report model" and "report version", which would explain why the app has
  model/version parsers that never fire here: **we have never sent the
  requests that trigger them.**

## Open questions

- What `46 16 17` toggles, and whether `46 11 14` / `46 11 15` return the
  model and version packets the app knows how to parse.
- What `0x27` and `0x28` carry.
- The controller reports voltage, never percent, so battery percentage is
  estimated from a Li-ion curve.

## Deliberately not implemented

Firmware update (`SANTROL_OTA`, CRC-16/CCITT, 20-byte chunks, `thus.bin` in the
app's assets). A failed flash can brick the controller.
