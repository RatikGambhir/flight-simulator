// Canvas-drawn flight instruments, refreshed from the latest sim snapshot.

import { CanvasTexture, SRGBColorSpace } from 'three'

export { drawGaEngine, drawSixPack, drawWhiskeyCompass, GA_PANEL } from './instruments/analog'
export { drawEICAS, drawND, drawPFD } from './instruments/digital'

export class InstrumentCanvas {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  readonly texture: CanvasTexture

  constructor(
    readonly width: number,
    readonly height: number,
    private draw: (g: CanvasRenderingContext2D, s: Float64Array, w: number, h: number) => void,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = 4
  }

  update(s: Float64Array) {
    this.draw(this.ctx, s, this.width, this.height)
    this.texture.needsUpdate = true
  }

  dispose() {
    this.texture.dispose()
  }
}
