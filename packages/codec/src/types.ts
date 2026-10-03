/** Colour model of the decoded image as stored in the HEAD chunk. */
export const ColorModel = {
  GRAY: 1,
  GRAY_ALPHA: 2,
  RGB: 3,
  RGBA: 4,
} as const;
export type ColorModel = (typeof ColorModel)[keyof typeof ColorModel];

export const COLOR_MODEL_NAMES: Record<number, string> = {
  1: 'Gray',
  2: 'Gray + Alpha',
  3: 'RGB',
  4: 'RGBA',
};

export function modelHasAlpha(m: number): boolean {
  return m === ColorModel.GRAY_ALPHA || m === ColorModel.RGBA;
}

export function modelIsGray(m: number): boolean {
  return m === ColorModel.GRAY || m === ColorModel.GRAY_ALPHA;
}

export function modelChannels(m: number): number {
  return m === ColorModel.GRAY ? 1 : m === ColorModel.GRAY_ALPHA ? 2 : m === ColorModel.RGB ? 3 : 4;
}

/** Codec used for the DATA payload. */
export const CodecId = {
  /** Predictive, context-modelled lossless coding ("SMG-L"). */
  LOSSLESS: 1,
  /** Palette (indexed colour) coding with neighbour-match contexts ("SMG-P"). */
  PALETTE: 2,
  /** Wavelet transform + context-modelled quantised coefficients ("SMG-W"). */
  WAVELET: 3,
} as const;
export type CodecId = (typeof CodecId)[keyof typeof CodecId];

export const CODEC_NAMES: Record<number, string> = {
  1: 'SMG-L (lossless predictive)',
  2: 'SMG-P (palette)',
  3: 'SMG-W (wavelet lossy)',
};

/** HEAD flags (bit field). */
export const HeadFlags = {
  /** The decoded pixels are bit-exact to the encoder's input. */
  EXACT: 1 << 0,
  /** Colours of fully transparent pixels were normalised (visually lossless). */
  CLEANED_TRANSPARENT: 1 << 1,
  /** The palette was reduced (lossy quantisation). */
  QUANTIZED: 1 << 2,
} as const;
