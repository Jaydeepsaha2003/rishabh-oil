// What a lab reading is measured in.
// -----------------------------------------------------------------------------
// Kept out of the picker component so the list and the guess are plain logic:
// testable on their own, and importable by anything that has to render a
// reading without also pulling in a popover.

// The units an oil mill's lab actually reports in. Short list on purpose: the
// point is two clicks, and anything unusual goes in the picker's free-text box
// rather than lengthening the list for everyone.
export const QUALITY_UNITS: { v: string; label: string; hint: string }[] = [
  { v: '%', label: '%', hint: 'FFA, moisture, impurities' },
  { v: '°C', label: '°C', hint: 'melting, cloud, pour point' },
  { v: 'mg KOH/g', label: 'mg KOH/g', hint: 'acid value' },
  { v: 'meq/kg', label: 'meq/kg', hint: 'peroxide value' },
  { v: 'ppm', label: 'ppm', hint: 'phosphorus, trace metals' },
  { v: 'cSt', label: 'cSt', hint: 'viscosity' },
  { v: '', label: 'Figure only', hint: 'Lovibond colour, ratios' }
]

// The unit a parameter is almost certainly in, from what it is called. Only a
// DEFAULT — offered the moment the name is typed, and overridden by one click
// — so a wrong guess costs nothing while a right one saves the trip entirely.
//
// '%' is the closing answer because it is the commonest reading, not because
// it is a fallback for nonsense: a parameter this list has not been taught
// about is far likelier to be a percentage than a viscosity.
export function guessUnit(name: string): string {
  const s = String(name || '').trim().toUpperCase()
  if (!s) return '%'
  if (/(MELT|CLOUD|POUR|SLIP|TITRE|TEMP|SMOKE|FLASH)/.test(s)) return '°C'
  if (/ACID\s*VALUE|\bAV\b/.test(s)) return 'mg KOH/g'
  if (/PEROXIDE|\bPV\b/.test(s)) return 'meq/kg'
  if (/(PHOSPH|IRON|COPPER|NICKEL|TRACE|SOAP|\bPPM\b)/.test(s)) return 'ppm'
  if (/VISCOS/.test(s)) return 'cSt'
  // Colour is a Lovibond figure and an index or a ratio is dimensionless —
  // the readings that carry no unit at all. Tested after the named units
  // above so "Acid VALUE" is not caught by the bare "VALUE".
  if (/(COLOU?R|LOVIBOND|RATIO|INDEX|IODINE|\bSG\b|DENSIT|VALUE\s*$)/.test(s)) return ''
  return '%'
}
