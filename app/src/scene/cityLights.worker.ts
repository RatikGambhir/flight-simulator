// Decodes the night-lights atlas off the main thread. The full-size JPEG
// (8192 x 4096) takes hundreds of milliseconds to decode and read back, which
// froze the flight for a moment every time dusk arrived.

interface CityRequest {
  url: string
  maxWidth: number
}

self.onmessage = async (event: MessageEvent<CityRequest>) => {
  const { url, maxWidth } = event.data
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const image = await createImageBitmap(await response.blob())
    const width = Math.min(image.width, maxWidth)
    const height = width / 2
    const scale = image.width / width
    const strip = 256
    const canvas = new OffscreenCanvas(width, strip)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('No 2D context in the worker')
    const pixels = new Uint8Array(width * height)
    // One channel, read in strips, so a second full RGBA atlas never exists.
    for (let y = 0; y < height; y += strip) {
      const rows = Math.min(strip, height - y)
      context.clearRect(0, 0, width, strip)
      context.drawImage(image, 0, y * scale, image.width, rows * scale, 0, 0, width, rows)
      const rgba = context.getImageData(0, 0, width, rows).data
      const offset = y * width
      for (let i = 0, n = width * rows; i < n; i++) pixels[offset + i] = rgba[i * 4]
    }
    image.close()
    ;(self as unknown as Worker).postMessage({ width, height, pixels }, [pixels.buffer])
  } catch (error) {
    ;(self as unknown as Worker).postMessage({ error: String(error) })
  }
}
