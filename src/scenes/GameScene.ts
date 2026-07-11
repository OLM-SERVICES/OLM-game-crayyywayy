import Phaser from 'phaser'

// ─────────────────────────────────────────────────────────────────────────
// This file merges two sources:
//   1. Your production GameScene — real bet lifecycle (PICK_SELECTED →
//      BET_REQUEST → BET_RESULT/BET_ERROR → BET_DONE), payout/multiplier
//      display, sound, timeout safety net. Untouched in substance.
//   2. The visual demo scene — responsive layout that picks a landscape or
//      portrait design profile based on actual viewport shape (fixes the
//      small-screen lane compression), and per-vehicle motion personality
//      (Okada zigzag, Keke steady, Danfo slow-start-then-burst) layered on
//      top of a fixed arrival time per vehicle.
//
// Vehicles, the background, and the finish flag now load your actual SVG
// art (background-road.svg, okada.svg, keke.svg, danfo.svg, finish-flag.svg)
// instead of being drawn procedurally. ASSET_BASE_PATH below is a guess —
// confirm it matches wherever these files actually sit under your public/
// folder, since a wrong path here silently 404s the same way we saw earlier
// in this session (blank canvas, no console error in some Phaser configs).
// ─────────────────────────────────────────────────────────────────────────

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

interface PlaceBetAckPayload {
  stake?: number
}

interface BetErrorPayload {
  message?: string
}

type SceneState = 'IDLE' | 'PICKED' | 'PLACING' | 'COUNTDOWN' | 'RACING' | 'RESULT'

const VEHICLES: Vehicle[] = ['OKADA', 'KEKE', 'DANFO']

const VEHICLE_META: Record<
  Vehicle,
  { label: string; sprite: string; targetWidth: number; multiplier: number; odds: string; color: number; darkColor: number }
> = {
  OKADA: { label: 'Okada', sprite: 'vehicle-okada', targetWidth: 90,  multiplier: 1.80, odds: '50%', color: 0xff5e3a, darkColor: 0x7a1f0d },
  KEKE:  { label: 'Keke',  sprite: 'vehicle-keke',  targetWidth: 110, multiplier: 3.00, odds: '30%', color: 0xffd23f, darkColor: 0x6b4e00 },
  DANFO: { label: 'Danfo', sprite: 'vehicle-danfo', targetWidth: 150, multiplier: 4.50, odds: '20%', color: 0xffe066, darkColor: 0x1a1a1a },
}

// CONFIRM THIS — path guess for where your svg assets live under public/.
// If they're not at public/games/crayyy-wayy/*.svg, change this one line.
const ASSET_BASE_PATH = '/games/crayyy-wayy'

// Palette pulled from the cover art: hot amber/orange fire on near-black,
// neon green + neon pink logo treatment, gold accents, blue lightning.
const PALETTE = {
  bgTop: 0x1a0a05,
  bgBottom: 0x000000,
  fireOrange: 0xff7a1a,
  fireAmber: '#ffb347',
  neonGreen: '#39ff8f',
  neonPink: '#ff3fb0',
  gold: '#ffd27a',
  amber: '#ffb347',
  ice: '#eaf6ff',
  lightningBlue: '#4fd8ff',
  danger: '#ff5e6a',
}

// Race timing — winner always finishes first; a bigger gap between places
// sells the result at a glance. Small per-run jitter keeps repeat races
// from feeling identical.
const BASE_DURATION_MS = 3400
const GAP_PER_PLACE_MS = 900
const RESULT_HOLD_MS   = 2600
const BET_REQUEST_TIMEOUT_MS = 10000
const COUNTDOWN_STEP_MS = 550

// Responsive design profiles — picking landscape vs portrait based on
// actual viewport aspect (rather than always forcing a portrait box) is
// what fixes the lane-crushing on short/wide screens. MIN_LANE_GAP_PX is
// a hard pixel floor so lanes can never visually collapse regardless of
// scale factor.
const PORTRAIT_DESIGN  = { w: 440, h: 780 }
const LANDSCAPE_DESIGN = { w: 900, h: 460 }
const MIN_LANE_GAP_PX  = 46

export class GameScene extends Phaser.Scene {
  private state: SceneState = 'IDLE'
  private selectedVehicle?: Vehicle
  private raceOrder: Vehicle[] = []
  private raceWinner?: Vehicle
  private isLandscapeProfile = true
  private laneGroundRatios: number[] = [0.40, 0.60, 0.80]

  private vehicleSprites = {} as Record<Vehicle, Phaser.GameObjects.Image>
  private laneY          = {} as Record<Vehicle, number>
  private selectGlow     = {} as Record<Vehicle, Phaser.GameObjects.Ellipse>
  private winnerAura?: Phaser.GameObjects.Ellipse
  private leaderCrown?: Phaser.GameObjects.Text
  private trailTimer?: Phaser.Time.TimerEvent
  private confettiEmitter?: Phaser.GameObjects.Particles.ParticleEmitter

  // ── Responsive layout ──────────────────────────────────────────────────
  private playW = 0
  private playH = 0
  private offsetX = 0
  private offsetY = 0
  private scaleFactor = 1

  private bgImage?: Phaser.GameObjects.Image
  private laneDividerGfx?: Phaser.GameObjects.Graphics
  private finishFlag?: Phaser.GameObjects.Image

  private titleTop?: Phaser.GameObjects.Text
  private titleBottom?: Phaser.GameObjects.Text
  private taglineText?: Phaser.GameObjects.Text
  private hintText?: Phaser.GameObjects.Text
  private countdownText?: Phaser.GameObjects.Text
  private vignette?: Phaser.GameObjects.Rectangle

  // ── Result card ──────────────────────────────────────────────────────
  private resultScrim?: Phaser.GameObjects.Rectangle
  private resultCardBg?: Phaser.GameObjects.Graphics
  private resultIcon?: Phaser.GameObjects.Text
  private resultTitle?: Phaser.GameObjects.Text
  private resultSubtitle?: Phaser.GameObjects.Text
  private payoutText?: Phaser.GameObjects.Text

  private bgMusic?: Phaser.Sound.BaseSound
  private raceSound?: Phaser.Sound.BaseSound
  private messageListener?: (event: MessageEvent) => void
  private betRequestTimeout?: Phaser.Time.TimerEvent

  constructor() {
    super('CrayyyWayyScene')
  }

  preload() {
    this.load.svg('bg-road',       `${ASSET_BASE_PATH}/background-road.svg` ,{ width: 800, height: 400 })
    this.load.svg('finish-flag',   `${ASSET_BASE_PATH}/finish-flag.svg` ,     { width: 40,  height: 300 })
    this.load.svg('vehicle-okada', `${ASSET_BASE_PATH}/okada.svg`, { width: 140, height: 90 })
    this.load.svg('vehicle-keke',  `${ASSET_BASE_PATH}/keke.svg`, { width: 150, height: 100 })
    this.load.svg('vehicle-danfo', `${ASSET_BASE_PATH}/danfo.svg`, { width: 200, height: 110 })

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
    this.buildBackground()
    this.buildHeader()
    this.buildLanes()

    this.hintText = this.add.text(this.relX(0.5), this.relY(0.94), 'Tap a vehicle to race', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(15),
      color: '#ffffffcc',
      fontStyle: 'bold',
    }).setOrigin(0.5).setShadow(0, 0, PALETTE.neonPink, 6, true, true)

    this.countdownText = this.add.text(this.relX(0.5), this.relY(0.5), '', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(64),
      color: PALETTE.gold,
      fontStyle: '900',
    }).setOrigin(0.5).setShadow(0, 0, PALETTE.neonPink, 14, true, true).setAlpha(0)

    this.vignette = this.add.rectangle(this.scale.width / 2, this.scale.height / 2, this.scale.width, this.scale.height, 0xff1f4a, 0)
      .setDepth(40)

    this.setupMessaging()
    this.sendToParent('GAME_READY', {})
    this.playIntroSting()
    this.setupAudio()

    this.scale.on('resize', this.onResize, this)
    this.events.once('shutdown', () => this.cleanup())
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

    // Landscape has room to spread lanes further apart vertically (less
    // top/bottom UI competing for space); portrait keeps a tighter band
    // but enforces a pixel floor so it can never visually compress.
    const ratios = this.isLandscapeProfile ? [0.42, 0.62, 0.82] : [0.40, 0.60, 0.80]
    const gapPx = (ratios[1] - ratios[0]) * this.playH
    if (gapPx < MIN_LANE_GAP_PX) {
      const neededGapRatio = MIN_LANE_GAP_PX / this.playH
      const center = 0.6
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
    // Repositioning mid-race would fight the active tweens, so only
    // re-layout while the scene is at rest.
    if (this.state !== 'IDLE') return
    this.computeLayout()

    this.redrawBackground()
    this.rebuildFinishFlag()
    this.repositionHeader()
    this.rebuildLanes()

    this.hintText?.setPosition(this.relX(0.5), this.relY(0.94)).setFontSize(this.sc(15))
    this.countdownText?.setPosition(this.relX(0.5), this.relY(0.5))
  }

  // ── Background: your real art, stretched to fill the play area ────────
  private buildBackground() {
    this.bgImage = this.add.image(this.relX(0.5), this.relY(0.5), 'bg-road').setDepth(-20)
    this.laneDividerGfx = this.add.graphics().setDepth(-10)
    this.redrawBackground()
    this.rebuildFinishFlag()
  }

  private redrawBackground() {
    this.bgImage?.setPosition(this.relX(0.5), this.relY(0.5)).setDisplaySize(this.playW, this.playH)

    // Thin lane-separator dashes only — the background art supplies the
    // actual road surface, but lane Y-positions are computed dynamically
    // (see computeLayout/MIN_LANE_GAP_PX) so they won't line up with any
    // divider baked into the art. This keeps the 3 lanes visually distinct
    // regardless of viewport shape.
    if (!this.laneDividerGfx) return
    this.laneDividerGfx.clear()
    this.laneDividerGfx.lineStyle(this.sc(2), 0xffffff, 0.22)
    this.laneGroundRatios.forEach((ratio, i) => {
      if (i === this.laneGroundRatios.length - 1) return
      const midY = this.relY((ratio + this.laneGroundRatios[i + 1]) / 2)
      for (let x = this.offsetX + 10; x < this.offsetX + this.playW - 10; x += this.sc(28)) {
        this.laneDividerGfx!.lineBetween(x, midY, x + this.sc(14), midY)
      }
    })
  }

  private rebuildFinishFlag() {
    this.finishFlag?.destroy()
    const img = this.add.image(this.relX(0.9), this.relY(0.5), 'finish-flag').setDepth(-4)
    const targetHeightPx = this.playH * 0.66
    const scale = targetHeightPx / img.height
    img.setScale(scale)
    this.finishFlag = img
  }

  // ── Header / branding ──────────────────────────────────────────────────
  private buildHeader() {
    this.titleTop = this.add.text(this.relX(0.5), this.relY(0.04), 'CRAYYY', {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: this.fs(30),
      color: PALETTE.neonGreen,
      fontStyle: '900',
    }).setOrigin(0.5).setShadow(0, 0, PALETTE.neonGreen, 12, true, true)

    this.titleBottom = this.add.text(this.relX(0.5), this.relY(0.08), 'WAYY', {
      fontFamily: 'Arial Black, Arial, sans-serif',
      fontSize: this.fs(30),
      color: PALETTE.neonPink,
      fontStyle: '900',
    }).setOrigin(0.5).setShadow(0, 0, PALETTE.neonPink, 12, true, true)

    this.taglineText = this.add.text(this.relX(0.5), this.relY(0.12), 'RUN THE STREETS. WIN THE HEAT!', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(12),
      color: PALETTE.gold,
      fontStyle: 'bold',
    }).setOrigin(0.5).setAlpha(0.95)
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
      this.titleBottom.setPosition(this.relX(0.5), this.relY(0.08))
      this.taglineText.setPosition(this.relX(0.5), this.relY(0.12))
    }
  }

  private playIntroSting() {
    if (!this.titleTop || !this.titleBottom || !this.taglineText) return

    ;[this.titleTop, this.titleBottom, this.taglineText].forEach((t) => {
      t.setScale(1.6).setAlpha(0)
      t.y += this.sc(40)
    })

    const introY = { top: this.relY(0.32), bottom: this.relY(0.32) + this.sc(34), tag: this.relY(0.32) + this.sc(66) }
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

  // ── Lanes / vehicles (drawn procedurally — no external assets needed) ──
  private buildLanes() {
    const startX = this.relX(0.12)

    VEHICLES.forEach((vehicle, i) => {
      const groundY = this.relY(this.laneGroundRatios[i])
      this.laneY[vehicle] = groundY

      const glow = this.add.ellipse(startX, groundY - this.sc(6), this.sc(100), this.sc(28), VEHICLE_META[vehicle].color, 0.32)
        .setAlpha(0)
      this.selectGlow[vehicle] = glow

      const sprite = this.buildVehicleSprite(vehicle)
      sprite.setPosition(startX, groundY)
      sprite.setInteractive({ useHandCursor: true })
      sprite.on('pointerover', () => { if (this.state === 'IDLE') sprite.setScale(sprite.scale * 1.08) })
      sprite.on('pointerout',  () => { if (this.state === 'IDLE') sprite.setScale(sprite.getData('baseScale')) })
      sprite.on('pointerdown', () => this.onVehicleTap(vehicle))
      this.vehicleSprites[vehicle] = sprite

      this.add.text(this.relX(0.5), groundY - this.sc(30), VEHICLE_META[vehicle].label, {
        fontFamily: 'Arial, sans-serif',
        fontSize: this.fs(11),
        color: '#ffffff66',
        fontStyle: 'bold',
      }).setOrigin(0.5)
    })
  }

  // Sprites are scaled at build-time to a target width for the scaleFactor
  // in effect then, so on resize we destroy and rebuild lanes from scratch
  // rather than try to rescale in place — this only runs while IDLE.
  private rebuildLanes() {
    VEHICLES.forEach((vehicle) => {
      this.vehicleSprites[vehicle]?.destroy()
      this.selectGlow[vehicle]?.destroy()
    })
    this.buildLanes()
  }

  // Loads the real SVG art, bottom-anchored (origin 0.5, 1) so it sits on
  // the lane's ground line, and scaled to a consistent target width per
  // vehicle regardless of the source SVG's native dimensions. If vehicles
  // look too high/low once you see real art, adjust the origin Y here —
  // 1 assumes the art is drawn sitting flush with the bottom of its
  // artboard; use e.g. 0.85 if there's built-in ground clearance/shadow.
  private buildVehicleSprite(vehicle: Vehicle): Phaser.GameObjects.Image {
    const meta = VEHICLE_META[vehicle]
    const img = this.add.image(0, 0, meta.sprite).setOrigin(0.5, 1)

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
      if (type === 'PLACE_BET')  this.onPlaceBetAck(payload)
      if (type === 'BET_RESULT') this.onBetResult(payload)
      if (type === 'BET_ERROR')  this.onBetError(payload)
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

  // ── Player interaction ────────────────────────────────────────────────
  private onVehicleTap(vehicle: Vehicle) {
    if (this.state !== 'IDLE') return

    this.state = 'PICKED'
    this.selectedVehicle = vehicle
    this.sound.play('sfx-select', { volume: 0.6 })

    VEHICLES.forEach((v) => {
      const isPicked = v === vehicle
      this.vehicleSprites[v].setAlpha(isPicked ? 1 : 0.32)
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

    this.hintText?.setText('Placing bet...')
    this.sendToParent('PICK_SELECTED', { pick: vehicle })
  }

  private onPlaceBetAck(payload: PlaceBetAckPayload | null) {
    if (this.state !== 'PICKED' || !this.selectedVehicle) return
    this.state = 'PLACING'
    this.hintText?.setText('Engines revving...')
    this.sound.play('sfx-click', { volume: 0.5 })

    // useCasinoBridge only calls the bet API in response to BET_REQUEST —
    // without sending this, nothing ever calls /casino/play and BET_RESULT
    // never arrives, leaving the scene stuck here indefinitely.
    this.sendToParent('BET_REQUEST', {
      game: 'CRAYYY_WAYY',
      stake: payload?.stake ?? 0,
      gameParams: { playerPick: this.selectedVehicle },
      clientSeed: this.generateClientSeed(),
    })

    // Safety net: if neither BET_RESULT nor BET_ERROR ever arrives,
    // fail visibly instead of hanging forever.
    this.betRequestTimeout = this.time.delayedCall(BET_REQUEST_TIMEOUT_MS, () => {
      if (this.state === 'PLACING') {
        this.hintText?.setText('Bet timed out — tap a vehicle to retry')
        this.resetScene()
      }
    })
  }

  private onBetError(payload: BetErrorPayload | null) {
    if (this.state !== 'PLACING' && this.state !== 'PICKED') return
    this.betRequestTimeout?.remove()
    this.hintText?.setText(payload?.message ?? 'Bet failed — tap a vehicle to retry')
    this.time.delayedCall(2000, () => this.resetScene())
  }

  // ── Countdown → Race → Result ──────────────────────────────────────────
  private onBetResult(payload: BetResultPayload) {
    if (!payload || this.state === 'COUNTDOWN' || this.state === 'RACING' || this.state === 'RESULT') return
    this.betRequestTimeout?.remove()
    this.state = 'COUNTDOWN'
    this.hintText?.setText('')

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

    this.raceSound = this.sound.add('sfx-race', { volume: 0.7 })
    this.raceSound.play()
    this.cameras.main.flash(180, 255, 210, 120, false)

    const finishX = this.relX(0.86)

    VEHICLES.forEach((vehicle) => {
      const place = this.raceOrder.indexOf(vehicle)
      const duration = BASE_DURATION_MS + place * GAP_PER_PLACE_MS + Phaser.Math.Between(-70, 70)
      const sprite = this.vehicleSprites[vehicle]
      const baseY = this.laneY[vehicle]

      // Per-vehicle personality wobble — purely cosmetic, runs independent
      // of forward progress so it never risks the fixed arrival time below.
      const wobbleAmp = vehicle === 'OKADA' ? 5 : vehicle === 'KEKE' ? 2.5 : 4
      const wobbleSpeed = vehicle === 'OKADA' ? 160 : vehicle === 'KEKE' ? 260 : 220
      this.tweens.add({
        targets: sprite,
        y: { from: baseY - this.sc(wobbleAmp), to: baseY + this.sc(wobbleAmp) },
        duration: wobbleSpeed,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })

      if (vehicle === 'DANFO') {
        // Slow start, then a hard acceleration to close the gap — sells
        // the "nail-biter" feeling that matches Danfo's low win rate /
        // high payout, while still landing exactly on `duration` total.
        const slowPortion = 0.32
        const slowDuration = duration * slowPortion
        const fastDuration = duration * (1 - slowPortion)
        const slowX = sprite.x + (finishX - sprite.x) * 0.18
        this.tweens.add({
          targets: sprite,
          x: slowX,
          duration: slowDuration,
          ease: 'Sine.easeIn',
          onComplete: () => {
            this.tweens.add({
              targets: sprite,
              x: finishX,
              duration: fastDuration,
              ease: 'Cubic.easeOut',
              onComplete: () => { if (vehicle === this.raceWinner) this.showFinishCrown(vehicle) },
            })
          },
        })
      } else {
        this.tweens.add({
          targets: sprite,
          x: finishX,
          duration,
          ease: 'Cubic.easeOut',
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
      .setDepth(-1)

    this.leaderCrown?.destroy()
    this.leaderCrown = this.add.text(sprite.x, sprite.y - this.sc(52), '★', {
      fontFamily: 'Arial, sans-serif',
      fontSize: this.fs(20),
      color: PALETTE.gold,
    }).setOrigin(0.5).setAlpha(0).setScale(0.3)
      .setShadow(0, 0, PALETTE.amber, 8, true, true)

    this.tweens.add({
      targets: this.leaderCrown!,
      alpha: 1,
      scale: 1,
      duration: 260,
      ease: 'Back.easeOut',
    })
  }

  // ── Result ───────────────────────────────────────────────────────────
  private showResult(payload: BetResultPayload) {
    this.state = 'RESULT'
    const win = payload.win

    // The parent holds "placing" UI state (and locks balance/stake) until
    // it hears this back — sending it late is what causes both a stuck
    // banner and a can't-change-balance issue on the parent side.
    this.sendToParent('BET_DONE', { newBalance: payload.newBalance })

    this.sound.play(win ? 'sfx-win' : 'sfx-loss', { volume: 0.8 })

    this.buildResultCard(payload, win)

    if (win) {
      this.cameras.main.flash(280, 255, 215, 60, false)
      this.burstConfetti(this.relX(0.5), this.relY(0.4))
    } else {
      this.cameras.main.shake(220, 0.005)
      this.tweens.add({
        targets: this.vignette!,
        alpha: 0.18,
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
    this.tweens.add({ targets: this.resultScrim, alpha: 0.55, duration: 220 })

    const accent = win ? PALETTE.neonGreen : PALETTE.neonPink
    this.resultCardBg = this.add.graphics().setDepth(49).setAlpha(0)
    this.resultCardBg.fillStyle(0x160a04, 0.94)
    this.resultCardBg.lineStyle(this.sc(2), win ? 0x39ff8f : 0xff3fb0, 0.9)
    this.resultCardBg.fillRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, this.sc(18))
    this.resultCardBg.strokeRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, this.sc(18))

    this.resultIcon = this.add.text(cx, cy - cardH * 0.30, win ? '🏆' : '💨', {
      fontSize: this.fs(30),
    }).setOrigin(0.5).setDepth(50).setAlpha(0).setScale(0.6)

    this.resultTitle = this.add.text(cx, cy - cardH * 0.02, win ? 'YOU WON!' : 'NO LUCK', {
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

    this.payoutText = this.add.text(cx, cy + cardH * 0.40, win ? '+₦0' : 'Better luck next time', {
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

  private resetScene() {
    this.state = 'IDLE'
    this.selectedVehicle = undefined
    this.raceOrder = []
    this.raceWinner = undefined
    this.betRequestTimeout?.remove()
    this.betRequestTimeout = undefined
    this.trailTimer?.remove()
    this.trailTimer = undefined

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

    const startX = this.relX(0.12)
    VEHICLES.forEach((vehicle) => {
      this.tweens.killTweensOf(this.vehicleSprites[vehicle])
      this.vehicleSprites[vehicle].setAlpha(1).setPosition(startX, this.laneY[vehicle])
      this.tweens.killTweensOf(this.selectGlow[vehicle])
      this.selectGlow[vehicle].setAlpha(0).setScale(1)
    })

    this.hintText?.setText('Tap a vehicle to race')
  }

  private cleanup() {
    if (this.messageListener) window.removeEventListener('message', this.messageListener)
    this.scale.off('resize', this.onResize, this)
    this.betRequestTimeout?.remove()
    this.trailTimer?.remove()
    this.bgMusic?.stop()
    this.raceSound?.stop()
    this.confettiEmitter?.destroy()
  }
}