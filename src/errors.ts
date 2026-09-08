export class FrameError extends Error {
  override name = 'FrameError'
  constructor(message: string) {
    super(message)
  }
}

export class FrameRlpError extends FrameError {
  override name = 'FrameRlpError'
  /**
   * Byte offset into the input at which the RLP was found to be malformed, when
   * the thrower knows one. `walkRlp` sets it; the scalar helpers (`parseRlpUint`,
   * `byteLength`) do not, because they are handed a field in isolation with no
   * position. `decodeFrameTx` copies it onto the `FrameDecodeError` it surfaces.
   */
  readonly offset: number | undefined
  constructor(message: string, offset?: number) {
    super(message)
    this.offset = offset
  }
}

export class FrameEncodeError extends FrameError {
  override name = 'FrameEncodeError'
}

export class FrameDecodeError extends FrameError {
  override name = 'FrameDecodeError'
  readonly offset: number | undefined
  constructor(message: string, offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`)
    this.offset = offset
  }
}
