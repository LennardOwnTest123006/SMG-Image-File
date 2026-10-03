# SMG Image Format — Specification v1.0

**Status:** Stable · **Version:** 1.0 · **File extension:** `.smg` · **Media type:** `image/x-smg` (unregistered)

SMG is a raster image format for 8-bit Gray, Gray+Alpha, RGB and RGBA images. A file is a small container of CRC-protected chunks; the pixel payload is coded with one of three codecs:

| ID | Codec | Kind | Typical content |
|----|-------|------|-----------------|
| 1 | **SMG-L** — predictive lossless with optional LZ77 pixel copies and colour cache | lossless | photos (exact), screenshots, UI, graphics |
| 2 | **SMG-P** — palette (indexed) coding with neighbour-match contexts | lossless or quantised | logos, icons, flat illustrations |
| 3 | **SMG-W** — CDF 9/7 wavelet with context-modelled coefficients, lossless alpha | lossy | photographs, gradients |

All three codecs share one entropy coder: an adaptive binary range coder with 16-bit probabilities (§6).

The reference implementation (`packages/codec`, TypeScript) is **normative** for the exact arithmetic of the entropy-coded streams (context derivation and probability updates). This document describes every structure and every decision procedure needed to reimplement it; where a description and the reference code disagree, the code defines the bitstream and the document will be corrected.

---

## 1. Conventions

- All multi-byte integers are **little-endian**.
- `u8`, `u16`, `u32` are unsigned integers of 1, 2, 4 bytes. `f32` is an IEEE-754 binary32.
- `varint` is unsigned LEB128 (7 data bits per byte, high bit = continuation), at most 8 bytes, value < 2^53.
- `string` is `varint` byte length followed by that many bytes of UTF-8.
- `block` is `varint` byte length followed by that many raw bytes.
- Pixel rows are stored top to bottom, pixels left to right. Samples are 8-bit and **not** premultiplied by alpha.
- "MUST", "SHOULD" and "MAY" are used as in RFC 2119.

## 2. File layout

```
offset  size  field
0       8     signature   89 53 4D 47 0D 0A 1A 0A   ("\x89SMG\r\n\x1A\n")
8       1     version_major  = 1
9       1     version_minor  = 0
10      …     chunk+      (HEAD first, DATA, TAIL last)
```

The signature follows the classic design of binary-safe magic numbers: a non-ASCII first byte (detects 7-bit transfers), the ASCII name, a CR-LF pair (detects line-ending conversion), Ctrl-Z (stops `type` on DOS) and a final LF.

### 2.1 Chunks

```
tag      4 bytes   ASCII letters, digits, '_' or space; first character is a letter
length   varint    payload length in bytes
payload  length bytes
crc      u32       CRC-32 (ISO-HDLC / IEEE 802.3, poly 0xEDB88320, init and xorout 0xFFFFFFFF)
                   computed over tag + length bytes + payload
```

**Criticality** is encoded in the tag: an upper-case first letter (`A`–`Z`) marks a **critical** chunk, a lower-case first letter an **ancillary** chunk.

- A decoder MUST reject a file that contains a critical chunk it does not understand (`SMG_E_UNKNOWN_CRITICAL`).
- A decoder MUST ignore ancillary chunks it does not understand.

### 2.2 Chunk order rules

1. The first chunk MUST be `HEAD`. Exactly one `HEAD`.
2. Exactly one `DATA` chunk.
3. `TAIL` MUST be the last chunk, MUST have length 0, and MUST come after `DATA`. Bytes after `TAIL` are an error.
4. Ancillary chunks MAY appear anywhere between `HEAD` and `TAIL`. Writers SHOULD place them before `DATA`.

### 2.3 Chunk registry (v1.0)

| Tag | Kind | Content |
|-----|------|---------|
| `HEAD` | critical | image header (§3) |
| `DATA` | critical | codec payload (§7–§9) |
| `TAIL` | critical | end marker, empty |
| `prof` | ancillary | colour profile: `u8 kind` (1 = ICC) + profile bytes |
| `exif` | ancillary | EXIF data in TIFF structure (no `Exif\0\0` prefix) |
| `xmpd` | ancillary | XMP packet, UTF-8 |
| `meta` | ancillary | text key/value pairs: `varint count`, then `count × (string key, string value)`; at most 1024 entries |
| `csum` | ancillary | pixel checksum: `u8 algorithm` (1 = CRC-32 of the decoded RGBA8 buffer) + `u32` value |

Recommended `meta` keys: `Title`, `Author`, `Description`, `Copyright`, `Software`, `Created` (ISO 8601), `Source`.

## 3. HEAD chunk

```
varint  width          1 … 2^24−1
varint  height         1 … 2^24−1
u8      color_model    1 = Gray, 2 = Gray+Alpha, 3 = RGB, 4 = RGBA
u8      bit_depth      8 (the only value defined in v1)
u8      codec          1 = SMG-L, 2 = SMG-P, 3 = SMG-W
u8      flags          bit 0 EXACT, bit 1 CLEANED_TRANSPARENT, bit 2 QUANTIZED; other bits 0
u8      quality        0–100 for lossy encodings, 255 = not applicable
…       (future minor versions may append fields; decoders ignore trailing bytes)
```

- **EXACT**: the decoded pixels are bit-identical to the encoder's input.
- **CLEANED_TRANSPARENT**: pixels are exact except that the RGB of fully transparent pixels (alpha = 0) was normalised. Visually lossless.
- **QUANTIZED**: the palette was produced by colour quantisation (lossy).

The colour model describes the decoded image. Decoders produce RGBA8: Gray is replicated into R, G, B; models without alpha decode with A = 255.

## 4. Decoding procedure

1. Check the signature (`SMG_E_SIGNATURE`) and `version_major == 1` (`SMG_E_VERSION`). Any `version_minor` is accepted.
2. Parse chunks, verify each CRC (`SMG_E_CRC`), apply the order rules (§2.2) and criticality rules (§2.1).
3. Validate `HEAD` (`SMG_E_HEADER`) and enforce resource limits (§10, `SMG_E_LIMIT`).
4. Decode `DATA` with the codec named in `HEAD` (`SMG_E_CODEC` if unknown).
5. If a `csum` chunk with algorithm 1 is present, decoders SHOULD verify it (`SMG_E_CHECKSUM`).

## 5. Colour transforms

SMG-L uses one of three reversible integer transforms (selected per image):

| ID | Planes | Forward | Inverse |
|----|--------|---------|---------|
| 0 | R, G, B | identity | identity |
| 1 | Y, Co, Cg (YCoCg-R) | `Co = R−B; t = B + (Co>>1); Cg = G−t; Y = t + (Cg>>1)` | `t = Y − (Cg>>1); G = Cg + t; B = t − (Co>>1); R = B + Co` |
| 2 | G, R−G, B−G (subtract green) | as named | `R = (R−G) + G`, `B = (B−G) + G` |

`>>` is an arithmetic shift. Plane ranges: Y/R/G/B in 0…255, Co/Cg/R−G/B−G in −255…255.

SMG-W uses floating-point YCbCr (BT.601 full range): `Y = 0.299R + 0.587G + 0.114B − 128`, `Cb = −0.168736R − 0.331264G + 0.5B`, `Cr = 0.5R − 0.418688G − 0.081312B`; inverse `R = Y' + 1.402Cr`, `G = Y' − 0.344136Cb − 0.714136Cr`, `B = Y' + 1.772Cb` with `Y' = Y + 128`, rounded half away from zero and clamped to 0…255.

## 6. Entropy coding

### 6.1 Binary range coder

- State: `low` (up to 33 bits), `range` (32 bits, initially `0xFFFFFFFF`), `cache` (initially 0), `cacheSize` (initially 1).
- Each adaptive context holds two 16-bit estimates of P(bit = 1), `fast` and `slow` (initially 32768), and a counter `n` (initially 0, saturating at 255).
- Coding probability: `p = (fast + slow) >> 1`, clamped to [24, 65512].
- Split: `bound = (range >>> 16) · p + (((range & 0xFFFF) · p) >>> 16)`.
- Bit 1 takes the lower sub-interval: `range = bound`. Bit 0: `low += bound; range −= bound`.
- Update after coding bit `b`: `rf = min(n + 1, 5)`, `rs = min(n + 1, 7)`, then `n = min(n + 1, 255)`; if `b = 1`: `fast += (65535 − fast) >> rf; slow += (65535 − slow) >> rs`, else `fast −= fast >> rf; slow −= slow >> rs`.
- Renormalise while `range < 2^24`: `range <<= 8` and shift `low` out byte-wise with carry propagation (`shiftLow`, identical to the LZMA range coder). The encoder flushes with five `shiftLow` calls; the first output byte is always 0.
- The decoder reads 5 bytes to initialise `code`. Reading more than 8 bytes past the end of a stream is a truncation error.
- Equiprobable ("direct") bits use `bound = range >>> 1` and no model.

### 6.2 Near-zero integer coding

A context set for signed integers with `E` exponent slots and `S` sign contexts contains `1 + S + 2E + E²` binary contexts. A value `v` is coded as:

1. `zero` flag (1 if `v = 0`, then stop).
2. `sign` bit (1 if negative) in sign context `s`.
3. `e = ⌊log2|v|⌋` in unary: bits `1` for `i = 0 … e−1` in exponent context `(sign, i)`, then a `0` unless `e = E−1`.
4. The `e` bits of `|v|` below its leading one, MSB first, each in mantissa context `(e, bit position)`.

### 6.3 Tree coding

An unsigned `k`-bit symbol is coded MSB first through a binary tree of `2^k` contexts (node index starts at 1, `node = 2·node + bit`).

## 7. SMG-L (codec 1) — lossless predictive

```
u8   transform   0, 1, 2 (§5); MUST be 0 for gray models
u8   flags       bit 0 = LZ mode; other bits 0
…    range-coded stream
```

**Planes.** With alpha, plane 0 is A. Then either one gray plane or three colour planes in transform order. Colour planes 2 and 3 reference the first colour plane for cross-plane context.

**Bands and predictors.** The image is processed in bands of 32 rows. At the start of each band, for every plane and every 32-pixel-wide tile, a predictor index 0…7 is tree-coded (3 bits) in a context formed by the plane and the previous tile's choice (the tile above for the first tile of a band):

| # | Predictor |
|---|-----------|
| 0 | MED (LOCO-I median edge detector) |
| 1 | (W + N + 1) >> 1 |
| 2 | W |
| 3 | N |
| 4 | W + N − NW |
| 5 | (W + NE + 1) >> 1 |
| 6 | gradient-adjusted (simplified CALIC GAP) |
| 7 | blend: weighted mean of {W+N−NW, W, N, NE}; weights `⌊2^24 / s²⌋ + 1` where `s` is 1 + 2·(error at W) + 2·(error at N) + (error at NW) + (error at NE) of that sub-predictor |

Missing neighbours at image borders are substituted: `N = W` on the first row (0 at the origin), `W = N` in the first column, `NW = NE = N` where unavailable, `WW = W`, `NN = N`.

**Bias cancellation.** A context made of the quantised gradients `N−NW`, `W−NW`, the sign of `NE−N` and the activity bucket accumulates the error of the uncorrected predictor; the rounded mean error is added to the prediction (counts halve at 64). Predictions are clamped to the plane's range.

**Residual coding.** Residual `r = sample − prediction` is coded with the near-zero coder (E = 11, three sign contexts selected by the sign of the bias accumulator). The context set is `plane × activity bucket (12) × reference bucket (4)`, where activity quantises `(|N−NW| + |W−NW| + |NE−N| + 2·(|eW| + |eN| + (|eNW| + |eNE|)/2)) / 2` (e = neighbouring residuals) with thresholds 0, 1, 3, 5, 8, 12, 18, 27, 40, 60, 95, and the reference bucket quantises the reference plane's |residual| at the same pixel into {0, 1–2, 3–8, >8}.

**Pixel order.** Pixels are visited in raster order; for each pixel all planes are coded in plane order.

**LZ mode** (flag bit 0). Before each pixel that is not covered by a running copy:

1. A **match flag** (context: W copied, N copied, activity of plane 0 ∈ {0, ≤12, >12}). On 1, a match follows:
   - match kind, tree-coded (3 bits, context = previous kind): 0–3 = recent distance #k, 4 = explicit distance;
   - explicit distance `d` as `dy = ⌊(d + ⌊w/2⌋) / w⌋` (unsigned) and `dx = d − dy·w` (signed);
   - length − 3 (near-zero coder, E = 17).
   The next `length` pixels (all planes) are copied from `d` pixels earlier in raster order. The 4-entry recent-distance list starts as {1, w, w+1, w−1} and is updated move-to-front.
2. Otherwise a **colour-cache flag**: on 1, an 8-bit tree-coded index selects a previously seen pixel value from a 256-entry hash cache; the pixel takes that value.
3. Otherwise the planes' residuals are coded as above.

Copied and cached pixels still update all prediction state (residual statistics, bias, blend errors) exactly as if they had been coded. Every pixel's value is inserted into the colour cache at slot `hash(values)`.

## 8. SMG-P (codec 2) — palette

```
varint  n            palette size, 1…256
…       range-coded: palette entries, then the index plane
```

**Palette.** Entries are coded in order; each stored channel (R; R,A; R,G,B; or R,G,B,A depending on the colour model) is the near-zero-coded difference to the previous entry's channel (E = 9). Encoders sort entries by alpha then luma.

**Indices.** In raster order, with neighbour indices W, N, NW, NE (absent at borders), the pixel index is coded as a cascade of binary flags — `= W?`, `= N?` (only if N ≠ W), `= NE?` (only if distinct from W, N), `= NW?` (only if distinct from W, N, NE) — in a context formed by six neighbour-equality bits (W=N, W=NW, N=NE, W=NE, N=NN, W=WW) and the previous pixel's outcome (matched W / matched another neighbour / explicit). If no flag is set, the index is tree-coded with `⌈log2 n⌉` bits in a context selected by the W index.

## 9. SMG-W (codec 3) — wavelet lossy

```
u8    flags         bit 0 colour (3 planes) else gray, bit 1 chroma 2×2 subsampled, bit 2 alpha
f32   base_step     luma quantiser step
f32   chroma_scale  chroma step multiplier
u8    recon         reconstruction offset δ = recon / 256
u8    levels_y      decomposition levels of plane 0
u8    levels_c      decomposition levels of chroma planes (0 if gray)
block alpha         present if flag bit 2: an SMG-L single-plane stream (no transform byte)
…     range-coded coefficients for Y (or gray), then Cb, Cr
```

**Transform.** Each plane is transformed with the CDF 9/7 lifting scheme (α = −1.586134342059924, β = −0.052980118572961, γ = 0.882911075530934, δ = 0.443506852043971, scaling ζ = 1.149604398: even samples × ζ, odd ÷ ζ), whole-sample symmetric extension, rows then columns, in Mallat layout. A level splits an `n`-sample line into `⌈n/2⌉` low and `⌊n/2⌋` high coefficients. Encoders choose levels by halving until the smaller dimension is ≤ 12 (max 6).

**Sub-bands** are coded per plane in the order LL, then for each level from coarsest to finest: HL, LH, HH.

**Quantisation.** The step of a sub-band is `base_step` (× `chroma_scale` for Cb/Cr) × a perceptual weight for detail bands:

| level | HL / LH | HH |
|-------|---------|----|
| 1 (finest) | 1.30 | 1.80 |
| 2 | 1.12 | 1.35 |
| 3 | 1.03 | 1.15 |
| 4 | 1.00 | 1.05 |
| ≥ 5 | 1.00 | 1.00 |

LL coefficients are reconstructed as `q · step`; detail coefficients as `sign(q) · (|q| + δ) · step` (0 stays 0).

**LL coding.** MED-predicted, residual near-zero-coded (E = 20) in a context selected by channel class (luma/chroma) and the quantised activity `|W−NW| + |N−NW|`.

**Detail coding.** Each detail band is split into 8×8 blocks in raster order. A block significance flag is coded in a context of {channel class, level class (1, 2, ≥3), orientation class (HL/LH, HH), left block significant, upper block significant, any non-zero coefficient in the co-located parent area, any non-zero co-located HL coefficient (for LH and HH)}. In significant blocks every coefficient is near-zero-coded (E = 20, nine sign contexts from the signs of W and N) in a context set selected by the same class plus the quantised magnitude `2(|W| + |N|) + |NW| + |NE| + 2|parent| + |siblings|` (thresholds 0, 1, 2, 3, 4, 6, 8, 11, 15, 21, 30, 44, 66). Neighbours not yet decoded count as 0.

**Reconstruction.** Inverse transform, chroma upsampled bilinearly (sample positions centred) when subsampled, inverse YCbCr (§5). Alpha, if present, comes from the lossless alpha stream.

**Quality mapping (informative).** The reference encoder maps quality `q` to `base_step = 2^(−1 + 0.18·(100−q))` for q ≥ 80 and `2^(2.6 + 0.0587·(80−q))` below; chroma is subsampled below quality 90; `chroma_scale = 1.2`. Encoders are free to choose any parameters.

## 10. Limits and security

- Dimensions are limited by the format to < 2^24. Implementations SHOULD apply stricter configurable limits before allocating memory; the reference decoder defaults to 32768 px per side and 100 megapixels.
- All lengths are validated against the remaining input before use. Every decoded sample, palette index, match distance and length is range-checked. All loops are bounded by the image size, so corrupt input cannot cause unbounded work.
- Metadata is never interpreted as code. Text entries are limited to 1024 keys.

## 11. Error codes

| Code | Meaning |
|------|---------|
| `SMG_E_SIGNATURE` | not an SMG file |
| `SMG_E_VERSION` | unsupported major version |
| `SMG_E_TRUNCATED` | input ended early (missing chunk, short payload, entropy stream overrun) |
| `SMG_E_CRC` | chunk CRC mismatch |
| `SMG_E_CHUNK_ORDER` | invalid chunk order, duplicate or misplaced chunk |
| `SMG_E_UNKNOWN_CRITICAL` | unknown critical chunk |
| `SMG_E_HEADER` | invalid HEAD field |
| `SMG_E_LIMIT` | image exceeds configured limits |
| `SMG_E_CORRUPT` | payload internally inconsistent |
| `SMG_E_CODEC` | codec not supported |
| `SMG_E_CHECKSUM` | decoded pixels do not match `csum` |
| `SMG_E_ARGUMENT` | invalid API argument |
| `SMG_E_ABORTED` | operation cancelled |
| `SMG_E_INPUT` | an input file in another format could not be parsed (tools) |

## 12. Versioning and compatibility

- **Major version** changes may alter anything; a v1 decoder rejects other majors.
- **Minor versions** are backwards compatible: they may add ancillary chunks, append fields to `HEAD`, and add new codec IDs. A v1.0 decoder reads any v1.x file whose codec it implements and reports `SMG_E_CODEC` otherwise.
- New *critical* chunk types require a new major version.
- Writers MUST emit `version_minor = 0` unless they use a v1.x feature.

## 13. Prior art and acknowledgements

SMG combines well-known techniques; none of the underlying algorithms are claimed as new inventions:

- Range coding (Martin 1979) with the carry-propagating byte output of the LZMA SDK (public domain).
- MED predictor and bias cancellation from LOCO-I / JPEG-LS (Weinberger, Seroussi, Sapiro); gradient-adjusted prediction after CALIC (Wu & Memon).
- Near-zero integer binarisation in the style of FLIF / JPEG XL modular mode.
- YCoCg-R (Malvar & Sullivan); subtract-green, backward references and colour cache as popularised by WebP lossless.
- CDF 9/7 wavelet and lifting (Cohen, Daubechies, Feauveau; Sweldens), as used in JPEG 2000.
- The chunk criticality convention is modelled on PNG.

The SMG container, chunk set, bitstream layouts, context models and the reference implementation are original to this project and released under the MIT license.
