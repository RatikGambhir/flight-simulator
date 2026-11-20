/** Stable order mirrors ShuttleSite::code in sim-core's protocol. */
export const SHUTTLE_SITES = [
  { id: 'houston', name: 'Houston · Johnson Space Center', lat: 29.5547, lon: -95.0939, detail: 'Texas, USA · assisted departure near Rocket Park' },
  { id: 'kennedy', name: 'Kennedy · LC-39A', lat: 28.6084, lon: -80.6043, detail: 'Florida, USA · historical Shuttle launch site' },
  { id: 'tanegashima', name: 'Tanegashima · Yoshinobu', lat: 30.4009, lon: 130.9773, detail: 'Japan · Pacific coast launch complex' },
  { id: 'sriharikota', name: 'Sriharikota · Satish Dhawan', lat: 13.7199, lon: 80.2304, detail: 'India · second launch pad, Bay of Bengal' },
] as const

export type ShuttleSite = typeof SHUTTLE_SITES[number]['id']
export function shuttleSite(code: number) { return SHUTTLE_SITES[code] ?? SHUTTLE_SITES[0] }
