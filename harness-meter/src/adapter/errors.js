export class AdapterMismatch extends Error {
  constructor (expectedPath, detail) {
    super(`Unrecognised Claude Code layout at ${expectedPath}: ${detail}`)
    this.name = 'AdapterMismatch'
    this.expectedPath = expectedPath
    this.detail = detail
  }
}
