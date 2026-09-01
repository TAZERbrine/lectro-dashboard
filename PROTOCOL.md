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
| `0x21` | 2 | current - high byte is a constant `0x80` | low byte x0.1 A |
| `0x22` | 2 | pack voltage | x0.01 V |
| `0x23` | 2 | remaining range | x0.1 km |
| `0x24` | 3 | front lamp, walk mode, assist level | one byte each |
| `0x26` | 1 | error code, `0` when healthy | raw |
| `0x27` | 1 | constant `01` in every capture - unknown | raw |
| `0x28` | 4 | first byte crept 0x23 -> 0x24 while charging - unknown | raw |

`0x24` was confirmed empirically: toggling the bike's light and changing assist
level both tracked correctly.

## Charging is not directly reported

Tag `0x21`'s high byte stays `0x80` with the charger plugged in, so it is **not**
a charge/discharge flag - the original app's `batteryCurrentPostiveNegative`
field name is misleading. Current stays at 0.2-1.2 A, which is the controller's
own electronics; the charger feeds the pack directly and bypasses the shunt, so
charge current never appears.

Charging *is* detectable indirectly: pack voltage climbing steadily while the
bike is stationary. A real capture showed 33.92 -> 33.93 -> 33.95 V with range
14.0 -> 14.4 km over about 45 seconds.

## Model and version packets

The app has parsers keyed on packet length (9 = version, 10-16 = model) reading
ASCII model codes from bytes 4-6 (`c3i`, `c5i`, `C5i E`, `C6i E`, `C8i`,
`KINZA-i`, `CLIX-i`, `F2i`, `F3i`, with **`f6i` as the fallback**). No such
packet has ever been seen from this bike - earlier "version packet: 128.0.0"
log lines were misparsed fragments, not real packets.

## Open questions

- **Can the bike be controlled?** Unresolved. The telemetry poll proves the bike
  accepts writes, so other commands plausibly exist, but none have been found.
- What `0x27` and `0x28` carry.
- The controller reports voltage, never percent, so battery percentage is
  estimated from a Li-ion curve.

## Deliberately not implemented

Firmware update (`SANTROL_OTA`, CRC-16/CCITT, 20-byte chunks, `thus.bin` in the
app's assets). A failed flash can brick the controller.
