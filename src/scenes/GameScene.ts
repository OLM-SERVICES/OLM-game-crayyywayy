import Phaser from 'phaser'

type Vehicle = 'OKADA' | 'KEKE' | 'DANFO'

interface CrayyyWayyResult {
  winner: Vehicle
  playerPick: Vehicle
  win: boolean
  payout: number
  multiplier: number
  positions: { vehicle: Vehicle; position: number }[]
}

interface BetResultPayload {
  win: boolean
  payout: number
  newBalance: number
  multiplier: number
  result: CrayyyWayyResult
  serverSeed: string
  serverSeedHash: string
  clientSeed: string
  nonce: number
}

interface StakeUpdatePayload {
  stake?: number
}

interface BetErrorPayload {
  message?: string
}

// IDLE -> CONFIRM (popup shown) -> PLACING (bet sent) -> COUNTDOWN -> RACING -> RESULT -> IDLE
type SceneState = 'IDLE' | 'CONFIRM' | 'PLACING' | 'COUNTDOWN' | 'RACING' | 'RESULT'

const VEHICLES: Vehicle[] = ['OKADA', 'KEKE', 'DANFO']

const VEHICLE_META: Record<
  Vehicle,
  { label: string; sprite: string; targetWidth: number; multiplier: number; odds: string; color: number; darkColor: number }
> = {
  OKADA: { label: 'Okada', sprite: 'vehicle-okada', targetWidth: 90,  multiplier: 1.80, odds: '50%', color: 0xff5e3a, darkColor: 0x7a1f0d },
  KEKE:  { label: 'Keke',  sprite: 'vehicle-keke',  targetWidth: 110, multiplier: 3.00, odds: '30%', color: 0xffd23f, darkColor: 0x6b4e00 },
  DANFO: { label: 'Danfo', sprite: 'vehicle-danfo', targetWidth: 190, multiplier: 4.50, odds: '20%', color: 0xffe066, darkColor: 0x1a1a1a },
}

const ASSET_BASE_PATH = '/games/crayyy-wayy'

const PALETTE = {
  bgTop: 0x1a0a05,
  bgHorizon: 0x3a1206,
  bgBottom: 0x000000,
  roadTop: 0x241009,
  roadBottom: 0x05050a,
  fireOrange: 0xff7a1a,
  fireAmber: '#ffb347',
  neonGreen: '#39ff8f',
  neonGreenHex: 0x39ff8f,
  neonPink: '#ff3fb0',
  neonPinkHex: 0xff3fb0,
  gold: '#ffd27a',
  goldHex: 0xffd27a,
  amber: '#ffb347',
  ice: '#eaf6ff',
  lightningBlue: '#4fd8ff',
  lightningBlueHex: 0x4fd8ff,
  danger: '#ff5e6a',
  dangerHex: 0xff5e6a,
}

const BASE_DURATION_MS = 3400
const GAP_PER_PLACE_MS = 900
const RESULT_HOLD_MS   = 2600
const BET_REQUEST_TIMEOUT_MS = 10000
const COUNTDOWN_STEP_MS = 550
const DEFAULT_STAKE = 100

const ROAD_SCROLL_IDLE = 0.045
const ROAD_SCROLL_RACE = 0.5
const LIGHTNING_MIN_DELAY = 5000
const LIGHTNING_MAX_DELAY = 12000
const TRAFFIC_LIGHT_STEP_MS = 1500

const PORTRAIT_DESIGN  = { w: 440, h: 780 }
const LANDSCAPE_DESIGN = { w: 900, h: 460 }
const MIN_LANE_GAP_PX  = 46
const RESIZE_DEBOUNCE_MS = 150

// Hanger-cable positions as fractions along the arch span (0 = left tie-in, 1 = right
// tie-in), matched to the reference tied-arch bridge photo/SVG.
const BRIDGE_HANGER_FRACTIONS = [0.111, 0.256, 0.4, 0.6, 0.744, 0.889]

export class GameScene extends Phaser.Scene {
  private state: SceneState = 'IDLE'
  private selectedVehicle?: Vehicle
  private raceOrder: Vehicle[] = []
  private raceWinner?: Vehicle
  private isLandscapeProfile = true
  private laneGroundRatios: number[] = [0.46, 0.64, 0.82]
  private horizonRatio = 0.24
  private currentStake = DEFAULT_STAKE

  private vehicleSprites = {} as Record<Vehicle, Phaser.GameObjects.Image>
  private laneY          = {} as Record<Vehicle, number>
  private laneNameLabels       = {} as Record<Vehicle, Phaser.GameObjects.Text>
  private laneMultiplierLabels = {} as Record<Vehicle, Phaser.GameObjects.Text>
  private selectGlow     = {} as Record<Vehicle, Phaser.GameObjects.Ellipse>
  private winnerAura?: Phaser.GameObjects.Ellipse
  private leaderCrown?: Phaser.GameObjects.Text
  private trailTimer?: Phaser.Time.TimerEvent
  private confettiEmitter?: Phaser.GameObjects.Particles.ParticleEmitter
  private smokeEmitter?: Phaser.GameObjects.Particles.ParticleEmitter

  private playW = 0
  private playH = 0
  private offsetX = 0
  private offsetY = 0
  private scaleFactor = 1

  // ── Animated background ──────────────────────────────────────────────
  private skyGfx?: Phaser.GameObjects.Graphics
  private skylineGfx?: Phaser.GameObjects.Graphics
  private bridgeGfx?: Phaser.GameObjects.Graphics
  private roadGfx?: Phaser.GameObjects.Graphics
  private laneLinesGfx?: Phaser.GameObjects.Graphics
  private laneDividerTiles: Phaser.GameObjects.TileSprite[] = []
  private laneCenterTiles: Phaser.GameObjects.TileSprite[] = []
  private distantTrafficDots: Phaser.GameObjects.Ellipse[] = []
  private neonSign?: Phaser.GameObjects.Text
  private palmLeft?: Phaser.GameObjects.Container
  private palmRight?: Phaser.GameObjects.Container
  private trafficPole?: Phaser.GameObjects.Rectangle
  private trafficBulbs: Phaser.GameObjects.Arc[] = []
  private trafficStep = 0
  private trafficTimer?: Phaser.Time.TimerEvent
  private lightningGfx?: Phaser.GameObjects.Graphics
  private lightningTimer?: Phaser.Time.TimerEvent
  private emberEmitter?: Phaser.GameObjects.Particles.ParticleEmitter
  private roadScrollSpeed = ROAD_SCROLL_IDLE
  private streetLamps: { pole: Phaser.GameObjects.Rectangle; bulb: Phaser.GameObjects.Arc; cone: Phaser.GameObjects.Graphics }[] = []

  // Tied-arch link bridge: static structure graphic + a handful of real GameObjects
  // layered on top so the arc lights can animate independently without redrawing
  // (and re-jittering) the whole bridge every frame.
  private bridgeTowerLights: Phaser.GameObjects.Arc[] = []
  private bridgeDeckLights: Phaser.GameObjects.Ellipse[] = []
  private bridgeCarDots: Phaser.GameObjects.Ellipse[] = []
  private bridgeLightTimer?: Phaser.Time.TimerEvent
  private bridgeLightStep = 0

  private finishGfx?: Phaser.GameObjects.Graphics
  private finishFlagText?: Phaser.GameObjects.Text

  private titleTop?: Phaser.GameObjects.Text
  private titleBottom?: Phaser.GameObjects.Text
  private taglineText?: Phaser.GameObjects.Text
  private hintText?: Phaser.GameObjects.Text
  private countdownText?: Phaser.GameObjects.Text
  private vignette?: Phaser.GameObjects.Rectangle

  private resultScrim?: Phaser.GameObjects.Rectangle
  private resultCardBg?: Phaser.GameObjects.Graphics
  private resultIcon?: Phaser.GameObjects.Text
  private resultTitle?: Phaser.GameObjects.Text
  private resultSubtitle?: Phaser.GameObjects.Text
  private payoutText?: Phaser.GameObjects.Text

  private confirmPopup?: Phaser.GameObjects.Container

  private bgMusic?: Phaser.Sound.BaseSound
  private raceSound?: Phaser.Sound.BaseSound
  private messageListener?: (event: MessageEvent) => void
  private betRequestTimeout?: Phaser.Time.TimerEvent
  private resizeDebounceTimer?: number

  constructor() {
    super('CrayyyWayyScene')
  }

  preload() {
    this.load.svg('vehicle-okada', `${ASSET_BASE_PATH}/okada.svg`, { width: 140, height: 90 })
    this.load.svg('vehicle-keke',  `${ASSET_BASE_PATH}/keke.svg`, { width: 150, height: 100 })
    this.load.svg('vehicle-danfo', `${ASSET_BASE_PATH}/danfo.svg`, { width: 220, height: 110 })

    this.load.audio('bg-music',   '/sounds/background-crayyywayy.mp3')
    this.load.audio('sfx-click',  '/sounds/click-crayyywayy.mp3')
    this.load.audio('sfx-select', '/sounds/select-crayyywayy.mp3')
    this.load.audio('sfx-race',   '/sounds/race-crayyywayy.mp3')
    this.load.audio('sfx-win',    '/sounds/win-crayyywayy.mp3')
    this.load.audio('sfx-loss',   '/sounds/loss-crayyywayy.mp3')
  }

  create() {
    this.sound.pauseOnBlur = false

    this.computeLayout()
    this.makeParticleTexture()
    this.makeLaneDashTexture()
    this.buildBackground()
    this.buildFinishLine()
    this.buildHeader()
    this.buildLanes()

    this.hintText = this.add.text(this.relX(0.5), this.relY(0.94), 'Tap a vehicle to race', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(15),
      color: '#ffffffcc',
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(30).setShadow(0, 0, PALETTE.neonPink, 6, true, true)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.forceCancel())

    this.countdownText = this.add.text(this.relX(0.5), this.relY(0.5), '', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(64),
      color: PALETTE.gold,
      fontStyle: '900',
    }).setOrigin(0.5).setDepth(41).setShadow(0, 0, PALETTE.neonPink, 14, true, true).setAlpha(0)

    this.vignette = this.add.rectangle(this.scale.width / 2, this.scale.height / 2, this.scale.width, this.scale.height, 0xff1f4a, 0)
      .setDepth(40)

    this.setupMessaging()
    this.sendToParent('GAME_READY', {})
    this.playIntroSting()
    this.setupAudio()

    this.scale.on('resize', this.onResize, this)
    this.events.once('shutdown', () => this.cleanup())
  }

  update(_time: number, delta: number) {
    // Scrolling road + lane dashes give the illusion of forward motion even at idle.
    this.laneDividerTiles.forEach((tile) => { tile.tilePositionX += delta * this.roadScrollSpeed })
    this.laneCenterTiles.forEach((tile) => { tile.tilePositionX += delta * this.roadScrollSpeed })
  }

  // ── Responsive layout ──────────────────────────────────────────────────
  private computeLayout() {
    const { width, height } = this.scale
    this.isLandscapeProfile = width >= height

    const design = this.isLandscapeProfile ? LANDSCAPE_DESIGN : PORTRAIT_DESIGN
    const maxAspect = design.w / design.h

    let playW: number
    let playH: number
    if (width / height > maxAspect) {
      playH = height
      playW = height * maxAspect
    } else {
      playW = width
      playH = width / maxAspect
    }

    this.playW = playW
    this.playH = playH
    this.offsetX = (width - playW) / 2
    this.offsetY = (height - playH) / 2
    this.scaleFactor = playW / design.w

    this.horizonRatio = this.isLandscapeProfile ? 0.24 : 0.30

    const ratios = this.isLandscapeProfile ? [0.32, 0.55, 0.78] : [0.36, 0.58, 0.80]
    const gapPx = (ratios[1] - ratios[0]) * this.playH
    if (gapPx < MIN_LANE_GAP_PX) {
      const neededGapRatio = MIN_LANE_GAP_PX / this.playH
      const center = 0.62
      ratios[0] = center - neededGapRatio
      ratios[1] = center
      ratios[2] = center + neededGapRatio
    }
    this.laneGroundRatios = ratios
  }

  private relX(ratio: number) { return this.offsetX + ratio * this.playW }
  private relY(ratio: number) { return this.offsetY + ratio * this.playH }
  private fs(px: number) { return `${Math.round(px * this.scaleFactor)}px` }
  private sc(px: number) { return px * this.scaleFactor }

  private onResize() {
    if (this.state !== 'IDLE') return
    if (this.resizeDebounceTimer) window.clearTimeout(this.resizeDebounceTimer)
    this.resizeDebounceTimer = window.setTimeout(() => this.applyResize(), RESIZE_DEBOUNCE_MS)
  }

  private applyResize() {
    this.computeLayout()
    this.redrawBackground()
    this.rebuildFinishLine()
    this.repositionHeader()
    this.rebuildLanes()

    this.hintText?.setPosition(this.relX(0.5), this.relY(0.94)).setFontSize(this.sc(15))
    this.countdownText?.setPosition(this.relX(0.5), this.relY(0.5))
  }

  // ── Animated in-scene background (no SVG) ──────────────────────────────
  private makeLaneDashTexture() {
    const g = this.add.graphics()
    g.fillStyle(0xffffff, 0.95)
    g.fillRect(0, 0, 46, 10)
    g.generateTexture('tex-lane-dash', 80, 10)
    g.destroy()
  }

  private buildBackground() {
    this.skyGfx = this.add.graphics().setDepth(-30)
    this.bridgeGfx = this.add.graphics().setDepth(-24)
    this.skylineGfx = this.add.graphics().setDepth(-25)
    this.roadGfx = this.add.graphics().setDepth(-16)
    this.laneLinesGfx = this.add.graphics().setDepth(-15)

    this.neonSign = this.add.text(0, 0, 'LASGIDI', {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: this.fs(16),
      color: PALETTE.neonPink,
      fontStyle: '900',
    }).setOrigin(0.5).setDepth(-22).setShadow(0, 0, PALETTE.neonPink, 10, true, true)

    this.buildTrafficLight()
    this.buildBridgeLights()
    this.palmLeft = this.buildPalmTree(true)
    this.palmRight = this.buildPalmTree(false)

    for (let i = 0; i < 2; i++) {
      const tile = this.add.tileSprite(0, 0, 10, 10, 'tex-lane-dash').setDepth(-14).setAlpha(1)
      this.laneDividerTiles.push(tile)
    }

    for (let i = 0; i < VEHICLES.length; i++) {
      const tile = this.add.tileSprite(0, 0, 10, 10, 'tex-lane-dash').setDepth(-14).setAlpha(0.32)
      this.laneCenterTiles.push(tile)
    }

    this.lightningGfx = this.add.graphics().setDepth(38).setAlpha(0)

    this.buildEmberEmitter()
    this.buildDistantTraffic()
    this.streetLamps = [this.buildStreetLamp(), this.buildStreetLamp()]
    this.streetLamps.forEach((lamp) => {
      this.tweens.add({
        targets: lamp.bulb,
        alpha: { from: 0.7, to: 1 },
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    })
    this.redrawBackground()
    // Skyline geometry is generated once and left alone — regenerating it on a timer
    // made the buildings visibly reshuffle, which read as "the buildings moving".
    this.drawSkyline(this.relY(this.horizonRatio))
    this.scheduleLightning()
    this.startTrafficLightCycle()
  }

  // Small, low-alpha light streaks drifting along the horizon like distant traffic —
  // gives a clear, deliberate motion cue without touching the skyline itself.
  private buildDistantTraffic() {
    const colors = [0xffe066, 0xff5e6a, 0xeaf6ff]
    for (let i = 0; i < 3; i++) {
      const dot = this.add.ellipse(0, 0, 10, 3, colors[i % colors.length], 0.5).setDepth(-23)
      this.distantTrafficDots.push(dot)
    }
    this.positionDistantTraffic()
  }

  private positionDistantTraffic() {
    const horizonY = this.relY(this.horizonRatio)
    this.distantTrafficDots.forEach((dot, i) => {
      this.tweens.killTweensOf(dot)
      const y = horizonY - this.sc(4 + i * 3)
      const goingRight = i % 2 === 0
      const fromX = goingRight ? this.offsetX - this.sc(20) : this.offsetX + this.playW + this.sc(20)
      const toX = goingRight ? this.offsetX + this.playW + this.sc(20) : this.offsetX - this.sc(20)
      dot.setPosition(fromX, y).setDisplaySize(this.sc(10), this.sc(3))
      this.tweens.add({
        targets: dot,
        x: toX,
        duration: 5000 + i * 1400,
        delay: i * 1600,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    })
  }

  private redrawBackground() {
    const horizonY = this.relY(this.horizonRatio)

    // Sky: warm dark gradient fading to black toward the top.
    this.skyGfx?.clear()
    this.skyGfx?.fillGradientStyle(PALETTE.bgTop, PALETTE.bgTop, PALETTE.bgHorizon, PALETTE.bgHorizon, 1, 1, 1, 1)
    this.skyGfx?.fillRect(this.offsetX, this.offsetY, this.playW, horizonY - this.offsetY)

    // Road: dark wet asphalt, lighter near the horizon like it's catching neon glow.
    this.roadGfx?.clear()
    this.roadGfx?.fillGradientStyle(PALETTE.roadTop, PALETTE.roadTop, PALETTE.roadBottom, PALETTE.roadBottom, 1, 1, 1, 1)
    this.roadGfx?.fillRect(this.offsetX, horizonY, this.playW, this.offsetY + this.playH - horizonY)

    // Wet-asphalt neon wash bleeding down from the skyline/bridge glow, fading out
    // within the first stretch of road — the rain-slicked-street look.
    this.roadGfx?.fillGradientStyle(0xff7a1a, 0xff2f92, 0xff7a1a, 0xff2f92, 0.28, 0.28, 0, 0)
    this.roadGfx?.fillRect(this.offsetX, horizonY, this.playW, this.sc(90))

    // subtle wet-road sheen streaks
    this.roadGfx?.fillStyle(0xffffff, 0.03)
    for (let i = 0; i < 5; i++) {
      const sy = horizonY + (this.playH - (horizonY - this.offsetY)) * (0.15 + i * 0.16)
      this.roadGfx?.fillRect(this.offsetX, sy, this.playW, this.sc(2))
    }

    // Faint ambient light flecks scattered on the asphalt — puddle reflections/grain
    // that read as real street texture rather than a flat color fill.
    this.roadGfx?.fillStyle(0xffb347, 0.45)
    for (let i = 0; i < 12; i++) {
      const fx = this.offsetX + this.playW * Phaser.Math.FloatBetween(0.04, 0.96)
      const fy = horizonY + (this.playH - (horizonY - this.offsetY)) * Phaser.Math.FloatBetween(0.06, 0.94)
      this.roadGfx?.fillCircle(fx, fy, this.sc(Phaser.Math.FloatBetween(0.7, 1.5)))
    }

    this.drawBridge(horizonY)
    this.drawSkyline(horizonY)
    this.drawLaneBands(horizonY)
    this.drawStreetDetail(horizonY)

    this.neonSign?.setPosition(this.relX(0.5), horizonY - this.sc(6)).setFontSize(this.sc(16))

    this.positionTrafficLight(horizonY)
    this.positionStreetLamps(horizonY)
    this.positionPalmTree(this.palmLeft, true, horizonY)
    this.positionPalmTree(this.palmRight, false, horizonY)
    this.positionDistantTraffic()

    // Lane divider dashes sit at the midpoint between adjacent lanes, spanning full width.
    this.laneDividerTiles.forEach((tile, i) => {
      if (i >= this.laneGroundRatios.length - 1) { tile.setVisible(false); return }
      tile.setVisible(true)
      const midY = this.relY((this.laneGroundRatios[i] + this.laneGroundRatios[i + 1]) / 2)
      tile.setPosition(this.relX(0.5), midY)
      tile.setSize(this.playW, this.sc(6))
      tile.setDisplaySize(this.playW, this.sc(6))
    })

    // Centre-of-lane dashes: sit directly under each vehicle's own travel line, so
    // every lane visibly reads as "this vehicle's road", not just a shared strip.
    this.laneCenterTiles.forEach((tile, i) => {
      const ratio = this.laneGroundRatios[i]
      if (ratio === undefined) { tile.setVisible(false); return }
      tile.setVisible(true)
      const y = this.relY(ratio) + this.sc(20)
      tile.setPosition(this.relX(0.5), y)
      tile.setSize(this.playW, this.sc(2))
      tile.setDisplaySize(this.playW, this.sc(2))
    })

    this.emberEmitter?.setPosition(this.relX(0.5), 0)
    if (this.emberEmitter) {
      ;(this.emberEmitter as any).setEmitZone?.({
        type: 'random',
        source: new Phaser.Geom.Rectangle(this.offsetX - this.relX(0.5), this.offsetY + this.playH - this.relY(0.5), this.playW, this.sc(4)),
      })
    }
  }

  private drawBridge(horizonY: number) {
    if (!this.bridgeGfx) return
    this.bridgeGfx.clear()

    // Tied-arch link bridge: a shallow arc spanning between two tie-in points on the
    // horizon, with vertical hanger cables dropping straight down to the deck — this
    // is the actual profile of the reference photo/SVG (an arch + hangers), not a
    // cable-stayed pylon.
    const leftX = this.relX(0.30)
    const rightX = this.relX(0.70)
    const spanW = rightX - leftX
    const deckY = horizonY + this.sc(1)
    const apexHeight = this.sc(74)
    const archY = (x: number) => {
      const t = (x - leftX) / spanW // 0..1 across the span
      const u = t * 2 - 1 // -1..1, centered
      return deckY - apexHeight * (1 - u * u)
    }

    // soft glow pass behind the crisp arc line, echoing the neon-lit look used
    // elsewhere in the scene (lightning, signage)
    this.bridgeGfx.lineStyle(this.sc(6), PALETTE.goldHex, 0.16)
    this.drawArcPath(leftX, rightX, archY)
    this.bridgeGfx.lineStyle(this.sc(2.2), PALETTE.goldHex, 0.8)
    this.drawArcPath(leftX, rightX, archY)

    const hangerPoints = BRIDGE_HANGER_FRACTIONS.map((f) => {
      const x = leftX + spanW * f
      return { x, yTop: archY(x), yBase: deckY }
    })

    this.bridgeGfx.lineStyle(this.sc(1.8), PALETTE.goldHex, 0.55)
    hangerPoints.forEach((p) => this.bridgeGfx?.lineBetween(p.x, p.yBase, p.x, p.yTop))

    this.positionBridgeLights(hangerPoints, deckY, leftX, rightX)
  }

  private drawArcPath(leftX: number, rightX: number, archY: (x: number) => number) {
    if (!this.bridgeGfx) return
    const steps = 24
    this.bridgeGfx.beginPath()
    for (let i = 0; i <= steps; i++) {
      const x = leftX + (rightX - leftX) * (i / steps)
      const y = archY(x)
      if (i === 0) this.bridgeGfx.moveTo(x, y)
      else this.bridgeGfx.lineTo(x, y)
    }
    this.bridgeGfx.strokePath()
  }

  // Real GameObjects layered over the static bridge graphic so the pylon's LED strip
  // and deck lamps can animate every frame without redrawing (and re-jittering) the
  // steelwork itself.
  private buildBridgeLights() {
    const stripColors = [0xff3fb0, 0x8a3ffb, 0x4fd8ff, 0x39ff8f, 0xffd23f]
    for (let i = 0; i < BRIDGE_HANGER_FRACTIONS.length; i++) {
      this.bridgeTowerLights.push(
        this.add.circle(0, 0, 3, stripColors[i % stripColors.length], 0.9).setDepth(-24)
      )
    }
    for (let i = 0; i < 8; i++) {
      this.bridgeDeckLights.push(
        this.add.ellipse(0, 0, 4, 4, 0xffb347, 0.7).setDepth(-24)
      )
    }
    for (let i = 0; i < 4; i++) {
      this.bridgeCarDots.push(
        this.add.ellipse(0, 0, 5, 2, i % 2 === 0 ? 0xfff3d6 : 0xff5e6a, 0.85).setDepth(-23)
      )
    }
    this.startBridgeLightCycle()
  }

  private positionBridgeLights(
    hangerPoints: { x: number; yTop: number; yBase: number }[],
    deckY: number,
    leftX: number,
    rightX: number,
  ) {
    // One small glowing bulb at the top of each hanger cable, where it meets the arc.
    this.bridgeTowerLights.forEach((light, i) => {
      const p = hangerPoints[i % hangerPoints.length]
      if (!p) return
      light.setPosition(p.x, p.yTop)
      light.setRadius(this.sc(3))
    })

    this.bridgeDeckLights.forEach((lamp, i) => {
      const t = (i + 1) / (this.bridgeDeckLights.length + 1)
      lamp.setPosition(leftX + (rightX - leftX) * t, deckY - this.sc(3))
      lamp.setDisplaySize(this.sc(4), this.sc(4))
    })

    this.bridgeCarDots.forEach((dot, i) => {
      this.tweens.killTweensOf(dot)
      const goingRight = i % 2 === 0
      const fromX = leftX - this.sc(6)
      const toX = rightX + this.sc(6)
      dot.setPosition(goingRight ? fromX : toX, deckY - this.sc(2))
      dot.setDisplaySize(this.sc(5), this.sc(2))
      this.tweens.add({
        targets: dot,
        x: goingRight ? toX : fromX,
        duration: 2600 + i * 400,
        delay: i * 700,
        repeat: -1,
        ease: 'Linear',
      })
    })
  }

  private startBridgeLightCycle() {
    const stripColors = [0xff3fb0, 0x8a3ffb, 0x4fd8ff, 0x39ff8f, 0xffd23f]
    this.bridgeLightTimer = this.time.addEvent({
      delay: 450,
      loop: true,
      callback: () => {
        this.bridgeLightStep = (this.bridgeLightStep + 1) % stripColors.length
        this.bridgeTowerLights.forEach((seg, i) => {
          seg.setFillStyle(stripColors[(i + this.bridgeLightStep) % stripColors.length], 0.9)
        })
      },
    })
    this.bridgeDeckLights.forEach((lamp, i) => {
      this.tweens.add({
        targets: lamp,
        alpha: { from: 0.4, to: 0.85 },
        duration: 900 + i * 120,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    })
  }

  private drawSkyline(horizonY: number) {
    if (!this.skylineGfx) return
    this.skylineGfx.clear()
    const buildingCount = this.isLandscapeProfile ? 14 : 10
    const bandTop = this.offsetY + (horizonY - this.offsetY) * 0.35

    let x = this.offsetX
    const step = this.playW / buildingCount
    for (let i = 0; i < buildingCount; i++) {
      const bw = step * Phaser.Math.FloatBetween(0.7, 1.05)
      const bh = (horizonY - bandTop) * Phaser.Math.FloatBetween(0.35, 1)
      const by = horizonY - bh
      this.skylineGfx.fillStyle(0x0d0605, 0.92)
      this.skylineGfx.fillRect(x, by, bw, bh)

      // lit windows: flicker handled by re-rolling random alpha each redraw pass
      const rows = Math.max(2, Math.floor(bh / this.sc(14)))
      const cols = Math.max(2, Math.floor(bw / this.sc(12)))
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (Math.random() > 0.4) continue
          const wx = x + this.sc(4) + c * this.sc(11)
          const wy = by + this.sc(6) + r * this.sc(13)
          if (wx > x + bw - this.sc(6) || wy > by + bh - this.sc(6)) continue
          const lit = Math.random() > 0.5
          this.skylineGfx.fillStyle(lit ? 0xffd27a : 0x4fd8ff, Phaser.Math.FloatBetween(0.35, 0.85))
          this.skylineGfx.fillRect(wx, wy, this.sc(4), this.sc(6))
        }
      }
      x += bw + step * 0.05
    }
  }

  private drawLaneBands(horizonY: number) {
    if (!this.laneLinesGfx) return
    const gfx = this.laneLinesGfx
    gfx.clear()

    const bottomY = this.offsetY + this.playH
    const boundaries = [
      horizonY,
      this.relY((this.laneGroundRatios[0] + this.laneGroundRatios[1]) / 2),
      this.relY((this.laneGroundRatios[1] + this.laneGroundRatios[2]) / 2),
      bottomY,
    ]

    // Each band is tinted with a whisper of its own vehicle's colour, so the three
    // lanes read as distinct tracks (Okada's / Keke's / Danfo's) rather than one
    // undifferentiated strip of road.
    VEHICLES.forEach((vehicle, i) => {
      const top = boundaries[i]
      const bottom = boundaries[i + 1]
      gfx.fillStyle(0x000000, 0.06)
      gfx.fillRect(this.offsetX, top, this.playW, bottom - top)
      gfx.fillStyle(VEHICLE_META[vehicle].color, 0.05)
      gfx.fillRect(this.offsetX, top, this.playW, bottom - top)
    })

    // Bright solid edge lines frame the whole road, like a real road shoulder marking.
    gfx.lineStyle(this.sc(2.5), 0xffffff, 0.32)
    gfx.lineBetween(this.offsetX, boundaries[0], this.offsetX + this.playW, boundaries[0])
    gfx.lineBetween(this.offsetX, boundaries[3], this.offsetX + this.playW, boundaries[3])

    // Painted amber shoulder lines just inside the edges, like real road-edge paint
    // marking where the tarmac gives way to the curb.
    gfx.lineStyle(this.sc(1.5), 0xffe066, 0.4)
    gfx.lineBetween(this.offsetX, boundaries[0] + this.sc(6), this.offsetX + this.playW, boundaries[0] + this.sc(6))
    gfx.lineBetween(this.offsetX, boundaries[3] - this.sc(6), this.offsetX + this.playW, boundaries[3] - this.sc(6))
  }

  private drawStreetDetail(horizonY: number) {
    if (!this.roadGfx) return
    const bottomY = this.offsetY + this.playH
    const nearStripH = Math.min(this.sc(46), (bottomY - horizonY) * 0.5)

    // Painted crosswalk band just past the horizon
    this.roadGfx.fillStyle(0xffffff, 0.10)
    for (let i = 0; i < 8; i++) {
      const bw = this.playW / 8
      if (i % 2 !== 0) continue
      this.roadGfx.fillRect(this.offsetX + i * bw + this.sc(4), horizonY + this.sc(6), bw - this.sc(8), this.sc(14))
    }

    // Manhole covers for road texture
    const manholeXs = [0.22, 0.5, 0.74]
    manholeXs.forEach((rx, i) => {
      const my = horizonY + nearStripH * (0.6 + i * 0.5)
      this.roadGfx?.fillStyle(0x000000, 0.4)
      this.roadGfx?.fillEllipse(this.relX(rx), my, this.sc(16), this.sc(6))
      this.roadGfx?.lineStyle(this.sc(1), 0x555555, 0.5)
      this.roadGfx?.strokeEllipse(this.relX(rx), my, this.sc(16), this.sc(6))
    })
  }

  private buildTrafficLight() {
    this.trafficPole = this.add.rectangle(0, 0, 4, 60, 0x111111).setDepth(-21)
    const colors = [0xff4d4d, 0xffd23f, 0x39ff8f]
    this.trafficBulbs = colors.map((c) =>
      this.add.circle(0, 0, 6, c, 0.25).setDepth(-20)
    )
  }

  private positionTrafficLight(horizonY: number) {
    if (!this.trafficPole) return
    const px = this.relX(0.08)
    const poleH = this.sc(70)
    this.trafficPole.setPosition(px, horizonY - poleH / 2).setSize(this.sc(4), poleH)
    this.trafficBulbs.forEach((bulb, i) => {
      bulb.setPosition(px, horizonY - poleH + this.sc(10) + i * this.sc(14))
      bulb.setRadius(this.sc(6))
    })
    this.updateTrafficBulbs()
  }

  private startTrafficLightCycle() {
    this.trafficTimer = this.time.addEvent({
      delay: TRAFFIC_LIGHT_STEP_MS,
      loop: true,
      callback: () => {
        this.trafficStep = (this.trafficStep + 1) % 3
        this.updateTrafficBulbs()
      },
    })
  }

  private updateTrafficBulbs() {
    this.trafficBulbs.forEach((bulb, i) => bulb.setAlpha(i === this.trafficStep ? 0.95 : 0.22))
  }

  private buildStreetLamp() {
    const pole = this.add.rectangle(0, 0, 3, 50, 0x1a1a1a).setDepth(-19)
    const bulb = this.add.circle(0, 0, 4, 0xffe6a8, 0.95).setDepth(-19)
    const cone = this.add.graphics().setDepth(-20)
    return { pole, bulb, cone }
  }

  private positionStreetLamps(horizonY: number) {
    const xs = [0.20, 0.80]
    xs.forEach((rx, i) => {
      const lamp = this.streetLamps[i]
      if (!lamp) return
      const poleH = this.sc(56)
      const topY = horizonY - this.sc(6)
      lamp.pole.setPosition(this.relX(rx), topY + poleH / 2).setSize(this.sc(3), poleH)
      lamp.bulb.setPosition(this.relX(rx), topY).setRadius(this.sc(4))
      lamp.cone.clear()
      lamp.cone.fillStyle(0xffe6a8, 0.08)
      lamp.cone.fillTriangle(
        this.relX(rx), topY,
        this.relX(rx) - this.sc(30), topY + this.sc(90),
        this.relX(rx) + this.sc(30), topY + this.sc(90),
      )
    })
  }

  private drawQuadraticCurve(
    g: Phaser.GameObjects.Graphics,
    x0: number, y0: number,
    cx: number, cy: number,
    x1: number, y1: number,
    steps = 16,
  ) {
    g.beginPath()
    g.moveTo(x0, y0)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const mt = 1 - t
      const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1
      const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1
      g.lineTo(x, y)
    }
    g.strokePath()
  }

  // Backlit silhouette palm tree with a rim-light glow so it reads clearly against
  // the dark sky, taller/fuller fronds, and a coconut cluster at the crown.
  private buildPalmTree(left: boolean): Phaser.GameObjects.Container {
    const g = this.add.graphics()
    const trunkH = 130
    const bend = left ? -14 : 14
    const silhouette = 0x120a08
    const rimColor = left ? PALETTE.neonPinkHex : PALETTE.lightningBlueHex

    // Soft glow halo behind the whole tree so it reads clearly against the dark sky
    g.fillStyle(rimColor, 0.07)
    g.fillEllipse(bend * 0.3, -trunkH * 0.55, trunkH * 0.9, trunkH * 1.1)

    // Trunk
    g.lineStyle(9, silhouette, 1)
    this.drawQuadraticCurve(g, 0, 0, bend * 0.55, -trunkH * 0.55, bend, -trunkH)
    g.lineStyle(1.5, rimColor, 0.5)
    this.drawQuadraticCurve(g, 2, 0, bend * 0.55 + 2, -trunkH * 0.55, bend + 2, -trunkH)

    g.fillStyle(silhouette, 1)
    g.fillEllipse(0, -1, 14, 6)

    const crownX = bend
    const crownY = -trunkH
    const startY = crownY + trunkH * 0.04

    const fronds: { end: [number, number]; ctrl: [number, number] }[] = [
      { end: [-0.95, -0.10], ctrl: [-0.50, -0.32] },
      { end: [0.95, -0.20], ctrl: [0.46, -0.38] },
      { end: [-0.68, -0.70], ctrl: [-0.32, -0.55] },
      { end: [0.68, -0.72], ctrl: [0.32, -0.55] },
      { end: [-0.30, -0.95], ctrl: [-0.14, -0.72] },
      { end: [0.32, -0.96], ctrl: [0.16, -0.73] },
      { end: [0, -1.02], ctrl: [0, -0.75] },
    ]

    fronds.forEach(({ end, ctrl }) => {
      const ex = crownX + end[0] * trunkH
      const ey = crownY + end[1] * trunkH
      const cx2 = crownX + ctrl[0] * trunkH
      const cy2 = crownY + ctrl[1] * trunkH
      g.lineStyle(5, silhouette, 1)
      this.drawQuadraticCurve(g, crownX, startY, cx2, cy2, ex, ey)
      g.lineStyle(1.2, rimColor, 0.45)
      this.drawQuadraticCurve(g, crownX, startY, cx2, cy2, ex, ey)
    })

    // coconut cluster
    g.fillStyle(silhouette, 1)
    g.fillCircle(crownX - 4, crownY + trunkH * 0.02, 4)
    g.fillCircle(crownX + 3, crownY + trunkH * 0.04, 4)
    g.fillCircle(crownX, crownY + trunkH * 0.08, 4)

    const container = this.add.container(0, 0, [g]).setDepth(-18)
    this.tweens.add({
      targets: container,
      angle: left ? 3.5 : -3.5,
      duration: 2400 + Math.random() * 800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
    return container
  }

  private positionPalmTree(container: Phaser.GameObjects.Container | undefined, left: boolean, horizonY: number) {
    if (!container) return
    const x = left ? this.relX(0.08) : this.relX(0.92)
    container.setPosition(x, horizonY).setScale(this.scaleFactor)
  }

  private buildEmberEmitter() {
    this.emberEmitter = this.add.particles(0, 0, 'particle-dot', {
      x: { min: 0, max: this.playW },
      y: 0,
      speedY: { min: -30, max: -70 },
      speedX: { min: -8, max: 8 },
      lifespan: { min: 2200, max: 3600 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 0.55, end: 0 },
      tint: [0xff7a1a, 0xffd27a, 0xff3fb0],
      frequency: 220,
      quantity: 1,
    }).setDepth(-13)
  }

  private scheduleLightning() {
    const delay = Phaser.Math.Between(LIGHTNING_MIN_DELAY, LIGHTNING_MAX_DELAY)
    this.lightningTimer = this.time.delayedCall(delay, () => {
      this.strikeLightning()
      this.scheduleLightning()
    })
  }

  private strikeLightning() {
    if (!this.lightningGfx) return
    const horizonY = this.relY(this.horizonRatio)
    const startX = Phaser.Math.Between(this.offsetX + this.playW * 0.15, this.offsetX + this.playW * 0.85)

    this.lightningGfx.clear()
    this.lightningGfx.lineStyle(this.sc(2), PALETTE.lightningBlueHex, 0.9)
    this.lightningGfx.beginPath()
    let x = startX
    let y = this.offsetY
    this.lightningGfx.moveTo(x, y)
    while (y < horizonY) {
      x += Phaser.Math.Between(-18, 18)
      y += Phaser.Math.Between(18, 34)
      this.lightningGfx.lineTo(x, y)
    }
    this.lightningGfx.strokePath()

    this.lightningGfx.setAlpha(0)
    this.tweens.add({
      targets: this.lightningGfx,
      alpha: { from: 0, to: 1 },
      duration: 70,
      yoyo: true,
      repeat: 1,
      onComplete: () => this.lightningGfx?.setAlpha(0),
    })
  }

  // ── Finish line (drawn in-scene, no image asset) ────────────────────────
  private buildFinishLine() {
    this.finishGfx = this.add.graphics().setDepth(-5)
    this.finishFlagText = this.add.text(0, 0, '🏁', { fontSize: this.fs(20) }).setOrigin(0.5).setDepth(-4)
    this.rebuildFinishLine()
  }

  private rebuildFinishLine() {
    if (!this.finishGfx) return
    const horizonY = this.relY(this.horizonRatio)
    const bottomY = this.offsetY + this.playH
    const fx = this.relX(0.86)
    const squareSize = this.sc(9)

    this.finishGfx.clear()
    this.finishGfx.fillStyle(0x000000, 0.5)
    this.finishGfx.fillRect(fx - squareSize, horizonY, squareSize * 2, bottomY - horizonY)

    let row = 0
    for (let y = horizonY; y < bottomY; y += squareSize) {
      for (let col = 0; col < 2; col++) {
        const isWhite = (row + col) % 2 === 0
        this.finishGfx.fillStyle(isWhite ? 0xffffff : 0x111111, 0.85)
        this.finishGfx.fillRect(fx - squareSize + col * squareSize, y, squareSize, squareSize)
      }
      row++
    }

    // pole + flag above the lanes
    this.finishGfx.lineStyle(this.sc(3), 0xdddddd, 0.9)
    this.finishGfx.lineBetween(fx, horizonY - this.sc(34), fx, horizonY)
    this.finishFlagText?.setPosition(fx + this.sc(10), horizonY - this.sc(34)).setFontSize(this.sc(20))
  }

  // ── Header / branding ──────────────────────────────────────────────────
  private buildHeader() {
    this.titleTop = this.add.text(this.relX(0.5), this.relY(0.04), 'CRAYYY', {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: this.fs(40),
      color: PALETTE.neonGreen,
      fontStyle: '900',
    }).setOrigin(0.5).setDepth(20).setShadow(0, 0, PALETTE.neonGreen, 12, true, true)

    this.titleBottom = this.add.text(this.relX(0.5), this.relY(0.10), 'WAYY', {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: this.fs(40),
      color: PALETTE.neonPink,
      fontStyle: '900',
    }).setOrigin(0.5).setDepth(20).setShadow(0, 0, PALETTE.neonPink, 12, true, true)

    this.taglineText = this.add.text(this.relX(0.5), this.relY(0.15), 'RUN THE STREETS. WIN THE HEAT!', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(12),
      color: PALETTE.gold,
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20).setAlpha(0.95)
    this.taglineText.setStyle({ letterSpacing: 2 })
  }

  private repositionHeader() {
    if (!this.titleTop || !this.titleBottom || !this.taglineText) return
    if (this.titleTop.scale < 0.9) {
      this.titleTop.setPosition(this.relX(0.5) - this.sc(34), this.relY(0.03))
      this.titleBottom.setPosition(this.relX(0.5) + this.sc(30), this.relY(0.03))
      this.taglineText.setAlpha(0)
    } else {
      this.titleTop.setPosition(this.relX(0.5), this.relY(0.04))
      this.titleBottom.setPosition(this.relX(0.5), this.relY(0.10))
      this.taglineText.setPosition(this.relX(0.5), this.relY(0.15))
    }
  }

  private playIntroSting() {
    if (!this.titleTop || !this.titleBottom || !this.taglineText) return

    ;[this.titleTop, this.titleBottom, this.taglineText].forEach((t) => {
      t.setScale(1.6).setAlpha(0)
      t.y += this.sc(40)
    })

    const introY = { top: this.relY(0.32), bottom: this.relY(0.32) + this.sc(44), tag: this.relY(0.32) + this.sc(80) }
    this.titleTop.setPosition(this.relX(0.5), introY.top)
    this.titleBottom.setPosition(this.relX(0.5), introY.bottom)
    this.taglineText.setPosition(this.relX(0.5), introY.tag)

    this.tweens.add({ targets: [this.titleTop, this.titleBottom], alpha: 1, scale: 1, duration: 450, ease: 'Back.easeOut' })
    this.tweens.add({ targets: this.taglineText!, alpha: 1, scale: 1, duration: 450, delay: 150, ease: 'Back.easeOut' })

    this.time.delayedCall(1700, () => {
      if (!this.titleTop || !this.titleBottom || !this.taglineText) return
      this.tweens.add({
        targets: this.titleTop!,
        x: this.relX(0.5) - this.sc(34),
        y: this.relY(0.03),
        scale: 0.42,
        duration: 500,
        ease: 'Cubic.easeInOut',
      })
      this.tweens.add({
        targets: this.titleBottom!,
        x: this.relX(0.5) + this.sc(30),
        y: this.relY(0.03),
        scale: 0.42,
        duration: 500,
        ease: 'Cubic.easeInOut',
      })
      this.tweens.add({
        targets: this.taglineText!,
        alpha: 0,
        y: this.taglineText!.y - this.sc(10),
        duration: 300,
        ease: 'Cubic.easeIn',
      })
    })
  }

  // ── Lanes / vehicles ────────────────────────────────────────────────────
  private buildLanes() {
    VEHICLES.forEach((vehicle, i) => {
      const meta = VEHICLE_META[vehicle]
      const groundY = this.relY(this.laneGroundRatios[i])
      this.laneY[vehicle] = groundY

      const sprite = this.buildVehicleSprite(vehicle)
      // Keep the sprite's left edge safely inside the play area — wide vehicles like the
      // Danfo bus would otherwise start partially clipped outside the iframe. The Danfo
      // also starts a little further back than the other two, so it doesn't visually
      // read as already ahead at the starting line.
      const halfW = sprite.displayWidth / 2
      const backOffset = vehicle === 'DANFO' ? this.sc(24) : 0
      const startX = Math.max(this.relX(0.12), this.offsetX + halfW + this.sc(14)) - backOffset

      const glow = this.add.ellipse(startX, groundY + this.sc(18), this.sc(100), this.sc(28), meta.color, 0.32)
        .setDepth(5)
        .setAlpha(0)
      this.selectGlow[vehicle] = glow

      sprite.setPosition(startX, groundY).setDepth(10)
      sprite.setInteractive({ useHandCursor: true })
      sprite.on('pointerover', () => { if (this.state === 'IDLE') sprite.setScale(sprite.scale * 1.08) })
      sprite.on('pointerout',  () => { if (this.state === 'IDLE') sprite.setScale(sprite.getData('baseScale')) })
      sprite.on('pointerdown', () => this.onVehicleTap(vehicle))
      this.vehicleSprites[vehicle] = sprite

      // Name + live multiplier displayed above every vehicle at all times, offset by the
      // sprite's own height so taller vehicles (e.g. Keke) don't crowd the text.
      const labelGap = sprite.displayHeight / 2 + this.sc(26)
      this.laneNameLabels[vehicle] = this.add.text(startX, groundY - labelGap, meta.label, {
        fontFamily: 'Arial, sans-serif',
        fontSize: this.fs(13),
        color: '#ffffffdd',
        fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(11)

      this.laneMultiplierLabels[vehicle] = this.add.text(startX, groundY - labelGap + this.sc(16), `${meta.multiplier.toFixed(2)}×`, {
        fontFamily: 'Arial, sans-serif',
        fontSize: this.fs(12),
        color: PALETTE.gold,
        fontStyle: '900',
      }).setOrigin(0.5).setDepth(11).setShadow(0, 0, PALETTE.amber, 4, true, true)
    })

    this.repositionLaneLabels()
  }

  private repositionLaneLabels() {
    VEHICLES.forEach((vehicle) => {
      const sprite = this.vehicleSprites[vehicle]
      if (!sprite) return
      const labelGap = sprite.displayHeight / 2 + this.sc(26)
      this.laneNameLabels[vehicle]?.setPosition(sprite.x, sprite.y - labelGap).setFontSize(this.sc(13))
      this.laneMultiplierLabels[vehicle]?.setPosition(sprite.x, sprite.y - labelGap + this.sc(16)).setFontSize(this.sc(12))
    })
  }

  private rebuildLanes() {
    VEHICLES.forEach((vehicle) => {
      this.vehicleSprites[vehicle]?.destroy()
      this.selectGlow[vehicle]?.destroy()
      this.laneNameLabels[vehicle]?.destroy()
      this.laneMultiplierLabels[vehicle]?.destroy()
    })
    this.buildLanes()
  }

  private buildVehicleSprite(vehicle: Vehicle): Phaser.GameObjects.Image {
    const meta = VEHICLE_META[vehicle]
    const img = this.add.image(0, 0, meta.sprite).setOrigin(0.5, 0.5)

    const targetWidthPx = this.sc(meta.targetWidth)
    const scale = img.width > 0 ? targetWidthPx / img.width : 1
    img.setScale(scale)
    img.setData('baseScale', scale)

    return img
  }

  private makeParticleTexture() {
    const g = this.add.graphics()
    g.fillStyle(0xffffff, 1)
    g.fillCircle(4, 4, 4)
    g.generateTexture('particle-dot', 8, 8)
    g.destroy()
  }

  // ── Audio ────────────────────────────────────────────────────────────
  private setupAudio() {
    this.bgMusic = this.sound.add('bg-music', { loop: true, volume: 0.35 })

    if (this.sound.locked) {
      this.hintText?.setText('Tap anywhere to enable sound')
      this.sound.once(Phaser.Sound.Events.UNLOCKED, () => {
        this.bgMusic?.play()
        if (this.state === 'IDLE') this.hintText?.setText('Tap a vehicle to race')
      })
    } else {
      this.bgMusic.play()
    }
  }

  // ── Parent <-> iframe messaging ──────────────────────────────────────
  private setupMessaging() {
    this.messageListener = (event: MessageEvent) => {
      const { type, payload } = event.data || {}
      // 'PLACE_BET' is the existing host ack (carries the real stake); 'STAKE_UPDATE' is
      // accepted too in case the host wants to push stake changes at any time.
      if (type === 'PLACE_BET' || type === 'STAKE_UPDATE') this.onStakeUpdate(payload)
      if (type === 'BET_RESULT')   this.onBetResult(payload)
      if (type === 'BET_ERROR')    this.onBetError(payload)
    }
    window.addEventListener('message', this.messageListener)
  }

  private sendToParent(type: string, payload: unknown) {
    window.parent?.postMessage({ type, payload }, '*')
  }

  private generateClientSeed(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  }

  private onStakeUpdate(payload: StakeUpdatePayload | null) {
    if (typeof payload?.stake !== 'number') return
    this.currentStake = payload.stake
    if (this.state === 'CONFIRM' && this.selectedVehicle) this.refreshConfirmPopup(this.selectedVehicle)
  }

  // ── Player interaction ────────────────────────────────────────────────
  private onVehicleTap(vehicle: Vehicle) {
    if (this.state !== 'IDLE') return

    this.state = 'CONFIRM'
    this.selectedVehicle = vehicle
    this.sound.play('sfx-select', { volume: 0.6 })

    VEHICLES.forEach((v) => {
      const isPicked = v === vehicle
      this.vehicleSprites[v].setAlpha(isPicked ? 1 : 0.32)
      this.laneNameLabels[v].setAlpha(isPicked ? 1 : 0.4)
      this.laneMultiplierLabels[v].setAlpha(isPicked ? 1 : 0.4)
      this.selectGlow[v].setAlpha(isPicked ? 0.9 : 0)
    })

    this.tweens.add({
      targets: this.selectGlow[vehicle],
      scaleX: 1.15,
      scaleY: 1.15,
      alpha: 0.5,
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })

    this.tweens.add({
      targets: this.vehicleSprites[vehicle],
      y: this.vehicleSprites[vehicle].y - this.sc(4),
      duration: 140,
      yoyo: true,
      repeat: 2,
      ease: 'Sine.easeInOut',
    })

    this.hintText?.setText('')
    this.sendToParent('PICK_SELECTED', { pick: vehicle })
    this.showConfirmPopup(vehicle)
  }

  // ── Stake confirmation popup ─────────────────────────────────────────
  private showConfirmPopup(vehicle: Vehicle) {
    this.confirmPopup?.destroy()

    const meta = VEHICLE_META[vehicle]
    const cardW = this.playW * 0.72
    const cardH = this.playH * 0.3
    const cx = this.relX(0.5)
    const cy = this.relY(0.5)

    const bg = this.add.graphics()
    bg.fillStyle(0x160a04, 0.96)
    bg.lineStyle(this.sc(2), meta.color, 0.9)
    bg.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, this.sc(16))
    bg.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, this.sc(16))

    const title = this.add.text(0, -cardH * 0.36, `${meta.label} — ${meta.multiplier.toFixed(2)}×`, {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: this.fs(18),
      color: '#ffffff',
      fontStyle: '900',
    }).setOrigin(0.5)

    const stakeLine = this.add.text(0, -cardH * 0.10, `Stake: ₦${this.currentStake.toLocaleString()}`, {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(15),
      color: '#ffffffcc',
      fontStyle: 'bold',
    }).setOrigin(0.5).setName('stakeLine')

    const winLine = this.add.text(0, cardH * 0.08, `Potential win: ₦${Math.round(this.currentStake * meta.multiplier).toLocaleString()}`, {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(16),
      color: PALETTE.gold,
      fontStyle: '900',
    }).setOrigin(0.5).setName('winLine')

    const btnY = cardH * 0.32
    const cancelBtn = this.buildPopupButton(-cardW * 0.22, btnY, 'Cancel', 0x2a2a2a, '#ffffff', () => this.cancelPick())
    const playBtn = this.buildPopupButton(cardW * 0.22, btnY, 'Play', meta.color, '#0a0a0a', () => this.confirmPick())

    this.confirmPopup = this.add.container(cx, cy, [bg, title, stakeLine, winLine, cancelBtn, playBtn])
      .setDepth(45)
      .setScale(0.7)
      .setAlpha(0)

    this.tweens.add({ targets: this.confirmPopup, alpha: 1, scale: 1, duration: 260, ease: 'Back.easeOut' })
  }

  private refreshConfirmPopup(vehicle: Vehicle) {
    if (!this.confirmPopup) return
    const meta = VEHICLE_META[vehicle]
    const stakeLine = this.confirmPopup.getByName('stakeLine') as Phaser.GameObjects.Text
    const winLine = this.confirmPopup.getByName('winLine') as Phaser.GameObjects.Text
    stakeLine?.setText(`Stake: ₦${this.currentStake.toLocaleString()}`)
    winLine?.setText(`Potential win: ₦${Math.round(this.currentStake * meta.multiplier).toLocaleString()}`)
  }

  private buildPopupButton(x: number, y: number, label: string, bgColor: number, textColor: string, onClick: () => void): Phaser.GameObjects.Container {
    const w = this.sc(120)
    const h = this.sc(42)
    const g = this.add.graphics()
    g.fillStyle(bgColor, 1)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, this.sc(10))

    const text = this.add.text(0, 0, label, {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(15),
      color: textColor,
      fontStyle: '900',
    }).setOrigin(0.5)

    const hitZone = this.add.rectangle(0, 0, w, h, 0x000000, 0).setInteractive({ useHandCursor: true })
    hitZone.on('pointerdown', onClick)
    hitZone.on('pointerover', () => this.tweens.add({ targets: [g, text], scale: 1.05, duration: 100 }))
    hitZone.on('pointerout',  () => this.tweens.add({ targets: [g, text], scale: 1, duration: 100 }))

    return this.add.container(x, y, [g, text, hitZone])
  }

  private hideConfirmPopup(onDone?: () => void) {
    if (!this.confirmPopup) { onDone?.(); return }
    const popup = this.confirmPopup
    this.confirmPopup = undefined
    this.tweens.add({
      targets: popup,
      alpha: 0,
      scale: 0.7,
      duration: 180,
      ease: 'Cubic.easeIn',
      onComplete: () => { popup.destroy(); onDone?.() },
    })
  }

  private cancelPick() {
    if (this.state !== 'CONFIRM') return
    this.sound.play('sfx-click', { volume: 0.4 })
    this.sendToParent('PICK_CANCELLED', {})
    this.hideConfirmPopup()
    // Reset immediately rather than waiting on the popup's fade-out tween, so a new
    // pick is never blocked by a stuck/slow transition.
    this.resetScene()
  }

  // Safety net: if a bet request never resolves (host silent, dropped connection, etc.)
  // the player is never permanently stuck — tapping the hint text forces a full reset.
  private forceCancel() {
    if (this.state === 'IDLE' || this.state === 'RACING' || this.state === 'RESULT') return
    this.sendToParent('PICK_CANCELLED', {})
    this.hideConfirmPopup()
    this.resetScene()
  }

  private confirmPick() {
    if (this.state !== 'CONFIRM' || !this.selectedVehicle) return
    this.state = 'PLACING'
    this.sound.play('sfx-click', { volume: 0.6 })
    this.hideConfirmPopup()
    this.hintText?.setText('Placing bet... (tap to cancel)')

    this.sendToParent('BET_REQUEST', {
      game: 'CRAYYY_WAYY',
      stake: this.currentStake,
      gameParams: { playerPick: this.selectedVehicle },
      clientSeed: this.generateClientSeed(),
    })

    this.betRequestTimeout = this.time.delayedCall(BET_REQUEST_TIMEOUT_MS, () => {
      if (this.state === 'PLACING') {
        this.hintText?.setText('Bet timed out — tap a vehicle to retry')
        this.resetScene()
      }
    })
  }

  private onBetError(payload: BetErrorPayload | null) {
    if (this.state !== 'PLACING' && this.state !== 'CONFIRM') return
    this.betRequestTimeout?.remove()
    this.hideConfirmPopup()
    this.hintText?.setText(payload?.message ?? 'Bet failed — tap a vehicle to retry')
    this.time.delayedCall(2000, () => this.resetScene())
  }

  // ── Countdown → Race → Result ──────────────────────────────────────────
  private onBetResult(payload: BetResultPayload) {
    if (!payload || this.state === 'COUNTDOWN' || this.state === 'RACING' || this.state === 'RESULT') return
    this.betRequestTimeout?.remove()
    this.state = 'COUNTDOWN'
    this.hintText?.setText('')

    // Fully reveal every vehicle before the race starts. During CONFIRM, the two
    // vehicles the player didn't pick were dimmed to alpha 0.32 (and their glow
    // tweens killed). That dimming was previously only cleared in resetScene(),
    // i.e. after the whole race + result sequence — so for the entire race, an
    // unpicked vehicle (including the actual winner) stayed near-transparent. When
    // it crossed the checkered finish strip, the black/white squares showed straight
    // through its faded body, which looked like "the finish line renders on top of
    // the vehicle". Clearing the dimming here, right as the race begins, fixes it.
    VEHICLES.forEach((v) => {
      this.tweens.killTweensOf(this.selectGlow[v])
      this.vehicleSprites[v].setAlpha(1)
      this.laneNameLabels[v].setAlpha(1)
      this.laneMultiplierLabels[v].setAlpha(1)
      this.selectGlow[v].setAlpha(0).setScale(1)
    })

    const { winner, positions } = payload.result
    this.raceWinner = winner
    this.raceOrder =
      positions?.length === 3
        ? [...positions].sort((a, b) => a.position - b.position).map((p) => p.vehicle)
        : [winner, ...VEHICLES.filter((v) => v !== winner)]

    this.runCountdown(['3', '2', '1', 'GO!'], () => this.startRace(payload))
  }

  private runCountdown(steps: string[], onDone: () => void) {
    if (!this.countdownText) return onDone()
    let i = 0

    const showNext = () => {
      if (i >= steps.length) {
        this.tweens.killTweensOf(this.countdownText!)
        this.countdownText?.setAlpha(0)
        onDone()
        return
      }
      this.tweens.killTweensOf(this.countdownText!)

      const label = steps[i]
      this.countdownText!.setText(label).setScale(0.4).setAlpha(1)
      this.sound.play('sfx-click', { volume: label === 'GO!' ? 0.9 : 0.4 })
      this.tweens.add({
        targets: this.countdownText!,
        scale: label === 'GO!' ? 1.3 : 1,
        duration: 220,
        ease: 'Back.easeOut',
        onComplete: () => {
          this.tweens.add({
            targets: this.countdownText!,
            alpha: 0,
            duration: 180,
            delay: COUNTDOWN_STEP_MS - 260,
          })
        },
      })
      i += 1
      this.time.delayedCall(COUNTDOWN_STEP_MS, showNext)
    }
    showNext()
  }

  private startRace(payload: BetResultPayload) {
    this.state = 'RACING'
    this.roadScrollSpeed = ROAD_SCROLL_RACE

    this.raceSound = this.sound.add('sfx-race', { volume: 0.7 })
    this.raceSound.play()
    this.cameras.main.flash(180, 255, 210, 120, false)

    const finishX = this.relX(0.86)
    // Every vehicle now actually reaches and crosses the checkered line — each lane is
    // its own vertical row, so there's no horizontal-overlap risk in letting all three
    // cross. Finishing order is conveyed by *when* each one arrives (see the per-place
    // duration below), not by how far it's allowed to travel — that's what makes a race
    // look like a race instead of some vehicles stopping short of the line.
    const maxTargetX = this.offsetX + this.playW - this.sc(20)
    const stopXFor = (place: number) => Math.min(finishX + this.sc(16) + place * this.sc(4), maxTargetX)

    VEHICLES.forEach((vehicle) => {
      const place = this.raceOrder.indexOf(vehicle)
      const targetX = stopXFor(place)
      const duration = BASE_DURATION_MS + place * GAP_PER_PLACE_MS + Phaser.Math.Between(-70, 70)
      const sprite = this.vehicleSprites[vehicle]
      const baseY = this.laneY[vehicle]

      const wobbleAmp = vehicle === 'OKADA' ? 5 : vehicle === 'KEKE' ? 2.5 : 4
      const wobbleSpeed = vehicle === 'OKADA' ? 160 : vehicle === 'KEKE' ? 260 : 220
      this.tweens.add({
        targets: sprite,
        y: { from: baseY - this.sc(wobbleAmp), to: baseY + this.sc(wobbleAmp) },
        duration: wobbleSpeed,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        onUpdate: () => this.repositionLaneLabels(),
      })

      if (vehicle === 'DANFO') {
        const slowPortion = 0.32
        const slowDuration = duration * slowPortion
        const fastDuration = duration * (1 - slowPortion)
        const slowX = sprite.x + (targetX - sprite.x) * 0.18
        this.tweens.add({
          targets: sprite,
          x: slowX,
          duration: slowDuration,
          ease: 'Sine.easeIn',
          onUpdate: () => this.repositionLaneLabels(),
          onComplete: () => {
            this.tweens.add({
              targets: sprite,
              x: targetX,
              duration: fastDuration,
              ease: 'Cubic.easeOut',
              onUpdate: () => this.repositionLaneLabels(),
              onComplete: () => { if (vehicle === this.raceWinner) this.showFinishCrown(vehicle) },
            })
          },
        })
      } else {
        this.tweens.add({
          targets: sprite,
          x: targetX,
          duration,
          ease: 'Cubic.easeOut',
          onUpdate: () => this.repositionLaneLabels(),
          onComplete: () => { if (vehicle === this.raceWinner) this.showFinishCrown(vehicle) },
        })
      }
    })

    this.spawnTrails()

    const totalRaceTime = BASE_DURATION_MS + 2 * GAP_PER_PLACE_MS + 300
    this.time.delayedCall(totalRaceTime, () => {
      this.raceSound?.stop()
      this.trailTimer?.remove()
      VEHICLES.forEach((v) => this.tweens.killTweensOf(this.vehicleSprites[v]))
      this.showResult(payload)
    })
  }

  private spawnTrails() {
    this.trailTimer = this.time.addEvent({
      delay: 55,
      loop: true,
      callback: () => {
        if (this.state !== 'RACING') return
        VEHICLES.forEach((vehicle) => {
          const sprite = this.vehicleSprites[vehicle]
          const isWinner = vehicle === this.raceWinner
          const puff = this.add.image(sprite.x - this.sc(46), sprite.y - this.sc(4), 'particle-dot')
            .setTint(VEHICLE_META[vehicle].color)
            .setAlpha(isWinner ? 0.6 : 0.35)
            .setScale(isWinner ? 1.6 : 1.1)
            .setDepth(9)
          this.tweens.add({
            targets: puff,
            x: puff.x - this.sc(26),
            alpha: 0,
            scale: 0.2,
            duration: 420,
            ease: 'Cubic.easeOut',
            onComplete: () => puff.destroy(),
          })
        })
      },
    })
  }

  private showFinishCrown(vehicle: Vehicle) {
    const sprite = this.vehicleSprites[vehicle]

    this.winnerAura?.destroy()
    this.winnerAura = this.add.ellipse(sprite.x - this.sc(14), sprite.y - this.sc(6), this.sc(130), this.sc(50), VEHICLE_META[vehicle].color, 0.22)
      .setDepth(9)

    this.leaderCrown?.destroy()
    this.leaderCrown = this.add.text(sprite.x, sprite.y - this.sc(70), '★', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(24),
      color: PALETTE.gold,
    }).setOrigin(0.5).setDepth(12).setAlpha(0).setScale(0.3)
      .setShadow(0, 0, PALETTE.amber, 8, true, true)

    this.tweens.add({
      targets: this.leaderCrown!,
      alpha: 1,
      scale: 1,
      duration: 260,
      ease: 'Back.easeOut',
    })
    this.tweens.add({
      targets: this.leaderCrown!,
      y: this.leaderCrown!.y - this.sc(6),
      duration: 500,
      delay: 260,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  // ── Result ───────────────────────────────────────────────────────────
  private showResult(payload: BetResultPayload) {
    this.state = 'RESULT'
    const win = payload.win

    // Freeze the scrolling lane lines right as the result appears, instead of
    // letting them keep racing along under the win/lose card.
    this.roadScrollSpeed = 0

    this.sound.play(win ? 'sfx-win' : 'sfx-loss', { volume: 0.8 })

    this.buildResultCard(payload, win)

    // Only tell the parent (and therefore update the visible balance) once
    // the result has actually been shown — sound played, card built. This
    // used to fire as the very first line of showResult(), before either of
    // those, which let the parent's balance display reveal the outcome
    // before the player had seen or heard anything on screen.
    this.sendToParent('BET_DONE', { newBalance: payload.newBalance })

    if (win) {
      this.cameras.main.flash(280, 255, 215, 60, false)
      this.burstConfetti(this.relX(0.5), this.relY(0.4))
    } else {
      this.cameras.main.shake(220, 0.005)
      const loserSprite = this.selectedVehicle ? this.vehicleSprites[this.selectedVehicle] : undefined
      this.burstSmoke(loserSprite?.x ?? this.relX(0.5), loserSprite?.y ?? this.relY(0.5))
      this.tweens.add({
        targets: this.vignette!,
        alpha: 0.22,
        duration: 150,
        yoyo: true,
        repeat: 1,
      })
    }

    this.time.delayedCall(RESULT_HOLD_MS, () => this.resetScene())
  }

  private buildResultCard(payload: BetResultPayload, win: boolean) {
    const { width, height } = this.scale
    const cardW = this.playW * 0.74
    const cardH = this.playH * 0.26
    const cx = this.relX(0.5)
    const cy = this.relY(0.46)

    this.resultScrim = this.add.rectangle(width / 2, height / 2, width, height, 0x000000, 0)
      .setDepth(48)
    this.tweens.add({ targets: this.resultScrim, alpha: win ? 0.55 : 0.62, duration: 220 })

    const accent = win ? PALETTE.neonGreen : PALETTE.danger
    const accentHex = win ? PALETTE.neonGreenHex : PALETTE.dangerHex
    this.resultCardBg = this.add.graphics().setDepth(49).setAlpha(0)
    this.resultCardBg.fillStyle(0x160a04, 0.94)
    this.resultCardBg.lineStyle(this.sc(2), accentHex, 0.9)
    this.resultCardBg.fillRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, this.sc(18))
    this.resultCardBg.strokeRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, this.sc(18))

    this.resultIcon = this.add.text(cx, cy - cardH * 0.30, win ? '🏆' : '📉', {
      fontSize: this.fs(30),
    }).setOrigin(0.5).setDepth(50).setAlpha(0).setScale(0.6)

    this.resultTitle = this.add.text(cx, cy - cardH * 0.02, win ? 'YOU WON!' : 'NOT THIS TIME', {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: this.fs(26),
      color: win ? PALETTE.gold : '#ffffff',
      fontStyle: '900',
    }).setOrigin(0.5).setDepth(50).setAlpha(0).setScale(0.7)
      .setShadow(0, 0, accent, 14, true, true)

    this.resultSubtitle = this.add.text(cx, cy + cardH * 0.20, `${VEHICLE_META[payload.result.winner].label} crossed first`, {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(13),
      color: '#ffffffbb',
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(50).setAlpha(0)

    this.payoutText = this.add.text(cx, cy + cardH * 0.40, win ? '+₦0' : 'Better luck next race', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(17),
      color: win ? PALETTE.neonGreen : PALETTE.danger,
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(50).setAlpha(0)

    this.tweens.add({
      targets: [this.resultCardBg, this.resultIcon, this.resultTitle, this.resultSubtitle, this.payoutText],
      alpha: 1,
      scale: 1,
      duration: 350,
      ease: 'Back.easeOut',
    })

    if (win) {
      const counter = { val: 0 }
      this.tweens.add({
        targets: counter,
        val: payload.payout,
        duration: 700,
        delay: 150,
        ease: 'Cubic.easeOut',
        onUpdate: () => {
          this.payoutText?.setText(`+₦${Math.floor(counter.val).toLocaleString()}  ·  ${payload.multiplier.toFixed(2)}×`)
        },
      })
    } else {
      // Sharp, brief shake on the whole card for impact, plus a pulsing red edge.
      const cardTargets = [this.resultCardBg, this.resultIcon, this.resultTitle, this.resultSubtitle, this.payoutText]
      this.time.delayedCall(360, () => {
        this.tweens.add({
          targets: cardTargets,
          x: '+=6',
          duration: 55,
          yoyo: true,
          repeat: 3,
          ease: 'Sine.easeInOut',
        })
      })
      this.tweens.add({
        targets: this.resultCardBg,
        alpha: { from: 1, to: 0.6 },
        duration: 220,
        delay: 500,
        yoyo: true,
        repeat: 2,
      })
    }
  }

  private burstConfetti(x: number, y: number) {
    const colors = [0x39ff8f, 0xff3fb0, 0xffd27a, 0xffffff]
    this.confettiEmitter = this.add.particles(x, y, 'particle-dot', {
      speed: { min: 120, max: 320 },
      angle: { min: 0, max: 360 },
      scale: { start: 1.4, end: 0 },
      lifespan: 900,
      quantity: 3,
      frequency: 12,
      tint: colors,
      gravityY: 220,
      emitting: true,
    }).setDepth(51)
    this.time.delayedCall(500, () => this.confettiEmitter?.stop())
    this.time.delayedCall(1500, () => this.confettiEmitter?.destroy())
  }

  private burstSmoke(x: number, y: number) {
    const colors = [0x555555, 0x2a2a2a, 0xff5e6a]
    this.smokeEmitter = this.add.particles(x, y, 'particle-dot', {
      speed: { min: 20, max: 70 },
      angle: { min: 250, max: 290 },
      scale: { start: 0.4, end: 2.2 },
      alpha: { start: 0.5, end: 0 },
      lifespan: { min: 700, max: 1100 },
      quantity: 2,
      frequency: 40,
      tint: colors,
      gravityY: -30,
      emitting: true,
    }).setDepth(47)
    this.time.delayedCall(450, () => this.smokeEmitter?.stop())
    this.time.delayedCall(1400, () => this.smokeEmitter?.destroy())
  }

  private resetScene() {
    this.state = 'IDLE'
    this.selectedVehicle = undefined
    this.raceOrder = []
    this.raceWinner = undefined
    this.roadScrollSpeed = ROAD_SCROLL_IDLE
    this.betRequestTimeout?.remove()
    this.betRequestTimeout = undefined
    this.trailTimer?.remove()
    this.trailTimer = undefined

    this.confirmPopup?.destroy()
    this.confirmPopup = undefined

    this.resultScrim?.destroy()
    this.resultCardBg?.destroy()
    this.resultIcon?.destroy()
    this.resultTitle?.destroy()
    this.resultSubtitle?.destroy()
    this.payoutText?.destroy()
    this.resultScrim = undefined
    this.resultCardBg = undefined
    this.resultIcon = undefined
    this.resultTitle = undefined
    this.resultSubtitle = undefined
    this.payoutText = undefined

    this.leaderCrown?.destroy()
    this.leaderCrown = undefined
    this.winnerAura?.destroy()
    this.winnerAura = undefined

    VEHICLES.forEach((vehicle) => {
      this.tweens.killTweensOf(this.vehicleSprites[vehicle])
      const sprite = this.vehicleSprites[vehicle]
      const backOffset = vehicle === 'DANFO' ? this.sc(24) : 0
      const startX = Math.max(this.relX(0.12), this.offsetX + sprite.displayWidth / 2 + this.sc(14)) - backOffset
      sprite.setAlpha(1).setPosition(startX, this.laneY[vehicle])
      this.laneNameLabels[vehicle].setAlpha(1)
      this.laneMultiplierLabels[vehicle].setAlpha(1)
      this.tweens.killTweensOf(this.selectGlow[vehicle])
      this.selectGlow[vehicle].setAlpha(0).setScale(1)
    })
    this.repositionLaneLabels()

    this.hintText?.setText('Tap a vehicle to race')
  }

  private cleanup() {
    if (this.messageListener) window.removeEventListener('message', this.messageListener)
    this.scale.off('resize', this.onResize, this)
    if (this.resizeDebounceTimer) window.clearTimeout(this.resizeDebounceTimer)
    this.betRequestTimeout?.remove()
    this.trailTimer?.remove()
    this.lightningTimer?.remove()
    this.trafficTimer?.remove()
    this.bridgeLightTimer?.remove()
    this.bgMusic?.stop()
    this.raceSound?.stop()
    this.confettiEmitter?.destroy()
    this.smokeEmitter?.destroy()
    this.emberEmitter?.destroy()
  }
}