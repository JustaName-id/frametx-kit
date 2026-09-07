export class FrameError extends Error {
  override name = 'FrameError'
  constructor(message: string) {
    super(message)
  }
}

export class FrameRlpError extends FrameError {
  override name = 'FrameRlpError'
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
