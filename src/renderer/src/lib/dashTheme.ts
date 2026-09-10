// The dashboard's two palettes.
// -----------------------------------------------------------------------------
// The only screen in the app that offers a dark mode, and deliberately so: it
// is the one page that gets left open on a wall screen or a second monitor all
// day, where a sheet of white is tiring and a dark board is not. Every other
// page is a register somebody is reading and keying into, and those stay light.
//
// Kept as an explicit token table rather than CSS variables because the charts
// need gradients and shadows, not just colours, and a bar's face, top and side
// have to be picked as a set — three separate variables that could be edited
// apart is how a 3D bar ends up lit from two directions at once.
export type DashTheme = {
  page: string
  head: string
  card: string
  sheen: string
  inset: string
  pill: string
  bd: string
  bd2: string
  ink: string
  ink2: string
  muted: string
  faint: string
  accent: string
  accentSoft: string
  accentBd: string
  axis: string
  gridline: string
  track: string
  hair: string
  shadow: string
  shadowUp: string
  haloA: string
  haloB: string
  blue: string
  violet: string
  red: string
  redSoft: string
  amber: string
  green: string
  redBgA: string
  redBgB: string
  redBd: string
  redScan: string
  onRed: string
  barBuyFace: string
  barBuyTop: string
  barBuySide: string
  barSellFace: string
  barSellTop: string
  barSellSide: string
  sparkBuy: string
  sparkSell: string
  rankBuy: string
  rankSell: string
  stockOk: string
  stockNeg: string
}

export const DASH_THEMES: Record<'dark' | 'light', DashTheme> = {
  dark: {
    page: '#04150F',
    head: 'rgba(7,33,26,.72)',
    card: 'linear-gradient(160deg,rgba(255,255,255,.055),rgba(255,255,255,.014))',
    sheen: 'linear-gradient(90deg,transparent,rgba(255,255,255,.13),transparent)',
    inset: 'rgba(255,255,255,.035)',
    pill: 'rgba(11,61,46,.6)',
    bd: '#1E4636',
    bd2: '#16382A',
    ink: '#EAF6EE',
    ink2: '#DCEFE4',
    muted: '#9CC6B1',
    faint: '#7FA593',
    accent: '#C7F03F',
    accentSoft: 'rgba(199,240,63,.12)',
    accentBd: 'rgba(199,240,63,.32)',
    axis: 'rgba(199,240,63,.22)',
    gridline: 'rgba(143,191,168,.11)',
    track: 'rgba(143,191,168,.14)',
    hair: 'rgba(143,191,168,.2)',
    shadow: '0 22px 42px -24px rgba(0,0,0,.85),inset 0 1px 0 rgba(255,255,255,.07)',
    shadowUp: '0 34px 54px -20px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.12)',
    haloA: 'rgba(18,133,90,.28)',
    haloB: 'rgba(199,240,63,.14)',
    blue: '#A9C8EA',
    violet: '#C7BCF0',
    red: '#F0AFAA',
    redSoft: '#F8D7D4',
    amber: '#F0C98A',
    green: '#9FE3BF',
    redBgA: 'rgba(179,38,30,.2)',
    redBgB: 'rgba(179,38,30,.05)',
    redBd: 'rgba(240,175,170,.34)',
    redScan: 'rgba(240,175,170,.12)',
    onRed: '#0A1F17',
    barBuyFace: 'linear-gradient(180deg,#7FB2E8,#2F6AAE)',
    barBuyTop: '#A9C8EA',
    barBuySide: '#24548C',
    barSellFace: 'linear-gradient(180deg,#DDF58F,#8FB824)',
    barSellTop: '#EAFAB8',
    barSellSide: '#6E9219',
    sparkBuy: 'linear-gradient(180deg,#7FB2E8,rgba(47,106,174,.25))',
    sparkSell: 'linear-gradient(180deg,#DDF58F,rgba(143,184,36,.25))',
    rankBuy: 'linear-gradient(90deg,#2F6AAE,#7FB2E8)',
    rankSell: 'linear-gradient(90deg,#8FB824,#DDF58F)',
    stockOk: 'linear-gradient(90deg,#12855A,#C7F03F)',
    stockNeg: 'linear-gradient(90deg,#B3261E,#F0AFAA)'
  },
  light: {
    page: '#F1F5EF',
    head: 'rgba(255,255,255,.86)',
    card: 'linear-gradient(160deg,#FFFFFF,#FAFCF8)',
    sheen: 'linear-gradient(90deg,transparent,rgba(11,61,46,.05),transparent)',
    inset: '#F7FAF6',
    pill: '#FFFFFF',
    bd: '#D6E2D6',
    bd2: '#D6E2D6',
    ink: '#0A1F17',
    ink2: '#1B2E25',
    muted: '#4A6157',
    faint: '#5A6B62',
    accent: '#0B6B45',
    accentSoft: 'rgba(11,107,69,.09)',
    accentBd: 'rgba(11,107,69,.28)',
    axis: 'rgba(11,61,46,.28)',
    gridline: 'rgba(11,61,46,.09)',
    track: '#E4ECE3',
    hair: '#DCE7DB',
    shadow: '0 14px 28px -20px rgba(10,31,23,.28),inset 0 1px 0 rgba(255,255,255,.9)',
    shadowUp: '0 22px 38px -18px rgba(10,31,23,.32),inset 0 1px 0 #fff',
    haloA: 'rgba(18,133,90,.12)',
    haloB: 'rgba(199,240,63,.3)',
    blue: '#1B4E82',
    violet: '#4A3D8C',
    red: '#B3261E',
    redSoft: '#8C2F26',
    amber: '#8A5300',
    green: '#0B6B45',
    redBgA: '#FDF3F2',
    redBgB: '#FBEBEA',
    redBd: '#F0D6D4',
    redScan: 'rgba(179,38,30,.07)',
    onRed: '#FFFFFF',
    barBuyFace: 'linear-gradient(180deg,#4E8CCB,#255C97)',
    barBuyTop: '#7FB2E8',
    barBuySide: '#1D4A7C',
    barSellFace: 'linear-gradient(180deg,#A8CF34,#6E9219)',
    barSellTop: '#C7F03F',
    barSellSide: '#587614',
    sparkBuy: 'linear-gradient(180deg,#4E8CCB,rgba(78,140,203,.22))',
    sparkSell: 'linear-gradient(180deg,#8FB824,rgba(143,184,36,.22))',
    rankBuy: 'linear-gradient(90deg,#255C97,#7FB2E8)',
    rankSell: 'linear-gradient(90deg,#6E9219,#C7F03F)',
    stockOk: 'linear-gradient(90deg,#0B6B45,#8FB824)',
    stockNeg: 'linear-gradient(90deg,#8C2F26,#E08A84)'
  }
}

const KEY = 'dashboard.theme'

// Read once, at module load, so the first paint is already in the chosen theme
// — reading it in an effect would flash the default first, which on a dark
// board is a white flash in a dim room.
export function storedDashTheme(): 'dark' | 'light' {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'dark'
  } catch {
    // A private window, or site data blocked. The default is not worth an
    // exception.
    return 'dark'
  }
}

export function storeDashTheme(v: 'dark' | 'light'): void {
  try {
    localStorage.setItem(KEY, v)
  } catch {
    /* nothing to do — the choice just will not survive a reload */
  }
}

// The keyframes the dashboard's motion needs. Injected by the component rather
// than added to main.css: nothing else in the app uses them, and a page that
// carries its own animation is easier to delete than one that leaves five
// orphaned rules behind in a global stylesheet.
export const DASH_KEYFRAMES = `
@keyframes dash-halo { 0%,100% { transform: scale(1); opacity: .85 } 50% { transform: scale(1.08); opacity: 1 } }
@keyframes dash-pulse { 0%,100% { opacity: 1; transform: scale(1) } 50% { opacity: .45; transform: scale(.82) } }
@keyframes dash-sheen { 0% { left: -80px } 55%,100% { left: 118% } }
@keyframes dash-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes dash-scan { 0% { transform: translateY(-70px) } 100% { transform: translateY(320px) } }
@media (prefers-reduced-motion: reduce) {
  .dash-anim, .dash-anim * { animation: none !important; transition: none !important }
}
`
