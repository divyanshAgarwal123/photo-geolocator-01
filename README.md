# Street Compass

[![make.fun photo-geolocator-01](https://make.fun/badge/photo-geolocator-01.svg)](https://make.fun/bounty/photo-geolocator-01)
[![rank](https://make.fun/badge/photo-geolocator-01/divyanshAgarwal123/photo-geolocator-01/rank.svg)](https://make.fun/bounty/photo-geolocator-01/leaderboard)
[![reward](https://make.fun/badge/photo-geolocator-01/divyanshAgarwal123/photo-geolocator-01/reward.svg)](https://make.fun/bounty/photo-geolocator-01)

A small, deterministic, model-free entry for **Find where a photo was taken**.
It reads JPEG pixels, checks for yellow road markings and coarse scene colours,
and returns a conservative latitude/longitude estimate for every photo.
It makes **zero model calls** and needs **no provider key**.

## Run

Requires Node 22.18 or newer. No packages need installing.

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node main.ts
node --test test.mjs
```

The URL must be the competition's photo environment. The program fetches its
`/photos` manifest and JPEGs, then posts one batch to `/answers`. Its only network
destination is this environment; redirects and off-origin photo URLs are refused.

With a separately downloaded make.fun kit:

```sh
node /path/to/photo-geolocator-01-kit/cli/makefun.mjs grade-local \
  --kit /path/to/photo-geolocator-01-kit --bot "$PWD" --driver process --instances 3
```

## Method

`jpeg.ts` implements baseline 8-bit JPEG decoding with Huffman entropy decoding,
dequantization and a separable inverse DCT. It computes paired pixel averages
directly, producing a half-resolution raster. Metadata is ignored. Progressive
JPEGs and unsupported formats use the same conservative fallback as weak scenes.

`main.ts` measures visible greenery, dryness, brightness, saturation and sky.
Its road detector searches thin yellow perspective lines with neutral pavement
on both sides. A few handwritten geographic rules use these cues; ambiguous
scenes fall back to 15 degrees north, 5 degrees east. These are broad assumptions,
not reliable country recognition. There are no trained weights, embeddings,
photo hashes, image-location tables, downloaded datasets or model clients.

## Practice evaluation and limits

The 25 photos in trial 0 were used during development. The geographic rules were
then frozen before examining the outcomes on trials 1 and 2 (50 other photos).
No ground-truth coordinates or practice images are shipped in this repository.

| Practice trial | Total error, km | Mean error per photo, km | Score |
|---|---:|---:|---:|
| 0 — development | 214,628 | 8,585 | 285,749 |
| 1 — holdout | 197,591 | 7,904 | 302,786 |
| 2 — holdout | 153,289 | 6,132 | 347,088 |

The holdout's mean error was approximately **7,018 km**. Its total error was
about **1.6% lower** than returning the fixed fallback for every image, though
trial 1 alone was worse. This is a weak heuristic, not a precise geolocator.
Practice results do not establish performance on the hidden competition photos.

All 75 practice photos decoded successfully. An independent Pillow comparison
on one image gave mean absolute RGB channel differences of approximately
0.75, 0.47 and 1.02 on the 0–255 scale. Differences include chroma upsampling and
the order of clipping/averaging. Unit tests cover lane orientation, colour-field
false positives, malformed JPEGs, API boundaries, repeated answer bytes and
launching through a symlink. The kit's live/replay check validates the full entry.

The practice images are OpenStreetView-5M / Mapillary contributors' work,
CC BY-SA 4.0, supplied by the official kit and not redistributed here. The code
in this repository is MIT licensed. The model-free requirement is deliberate:
there is no hidden paid inference path.

---

Entered on [make.fun](https://make.fun/?ref=bkf8wnha&utm_source=github&utm_medium=readme&utm_campaign=photo-geolocator-01).
