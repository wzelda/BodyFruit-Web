// GameEngine.js — full game logic ported from Python main.py
import {
  LEVELS, TRAIL_HISTORY, TRAIL_MAX_AGE, HAND_LOSS_GRACE, FREEZE_DURATION,
  FREEZE_SPEED_FACTOR, COMBO_WINDOW, MAX_COMBO, EXTRA_LIFE_SCORE, INTRO_DUR,
  SELECT_HOLD, GOLDEN_FRUIT_MULTIPLIER,
} from '../utils/constants.js';
import { spawnFruit, markSliced, segmentDistance } from './Fruit.js';

export const ST = {
  SELECT: 'select',
  INTRO: 'intro',
  PLAYING: 'playing',
  RESULT: 'result',
};

export class GameEngine {
  constructor(canvasW, canvasH) {
    this.W = canvasW;
    this.H = canvasH;
    this.state = ST.SELECT;

    // Hover card detection
    this.hoverCard = -1;
    this.hoverStart = 0;
    this.cardBounds = {}; // { level: {x,y,w,h} }

    // Per-game state
    this.score = 0;
    this.lives = 5;
    this.combo = 1.0;
    this.comboChain = 0;
    this.lastSlice = 0;
    this.levelStart = 0;
    this.lastSpawn = 0;
    this.freezeActive = false;
    this.freezeUntil = 0;
    this.lastLifeMilestone = 0;
    this.warned10 = false;
    this.warned5 = false;
    this.introStart = 0;
    this.chosenLevel = 1;
    this.levelCfg = LEVELS[1];
    this.bestScore = 0;

    // Game objects
    this.fruits = [];
    this.popups = [];
    this.trails = new Map(); // handId -> [{x,y,t}]
    this.handLastSeen = new Map(); // handId -> timestamp
    this.splashes = [];
    this.prompt = '';
    this.promptUntil = 0;

    // Result
    this.resultPassed = false;
    this.resultReason = '';
    this.resultHoverBtn = null; // 'again' | 'menu' | null
    this.resultHoverStart = 0;
    this.resultButtonBounds = {}; // { again: {x,y,w,h}, menu: {x,y,w,h} }

    // Listeners
    this.onStateChange = null;
    this.onScoreChange = null;
    this.onLivesChange = null;
    this.onPrompt = null;
  }

  setCanvasSize(w, h) {
    this.W = w;
    this.H = h;
  }

  setCardBounds(bounds) {
    this.cardBounds = bounds;
  }

  setResultButtonBounds(bounds) {
    this.resultButtonBounds = bounds || {};
  }

  // ── Input ──────────────────────────────────────────────────────────────

  updateFingers(fingers, now) {
    const seenIds = new Set();
    for (const f of fingers) {
      seenIds.add(f.id);
      // Prefer tracker-supplied timestamps (bridge samples across detection gaps)
      this.updateFinger(f.x, f.y, f.t ?? now, f.id);
    }
    // Keep temporarily missing hand trails during HAND_LOSS_GRACE to avoid breaking fast wide swipes
    for (const id of [...this.trails.keys()]) {
      if (id === 'pointer' || seenIds.has(id)) continue;
      const lastSeen = this.handLastSeen.get(id) ?? -Infinity;
      if (now - lastSeen > HAND_LOSS_GRACE) {
        this.trails.delete(id);
        this.handLastSeen.delete(id);
      }
    }
  }

  updateFinger(x, y, now, id = 'pointer') {
    // x,y in canvas pixels; null means no detection
    if (x == null) {
      this.clearFinger(id);
      return;
    }
    let trail = this.trails.get(id);
    if (!trail) {
      trail = [];
      this.trails.set(id, trail);
    }

    // If re-acquiring after a short gap without bridge samples, insert lerp points
    const last = trail[trail.length - 1];
    if (last && now > last.t + 0.05 && now - last.t < HAND_LOSS_GRACE) {
      const gap = now - last.t;
      const steps = Math.min(4, Math.max(1, Math.round(gap / 0.03)));
      for (let i = 1; i <= steps; i++) {
        const u = i / (steps + 1);
        trail.push({
          x: last.x + (x - last.x) * u,
          y: last.y + (y - last.y) * u,
          t: last.t + gap * u,
        });
      }
    }

    // Ignore out-of-order samples (can happen if bridge + coast overlap)
    if (last && now < last.t) return;

    trail.push({ x, y, t: now });
    while (trail.length > TRAIL_HISTORY) trail.shift();
    // Only advance "seen" with real-time or newer samples so grace still expires
    const prevSeen = this.handLastSeen.get(id) ?? -Infinity;
    if (now >= prevSeen) this.handLastSeen.set(id, now);
  }

  clearFinger(id = 'pointer') {
    this.trails.delete(id);
    this.handLastSeen.delete(id);
  }

  handleKey(key, now) {
    if (key === 'r' && this.state === ST.RESULT) this.state = ST.SELECT;
    if (key === '1' && this.state === ST.SELECT) this._beginLevel(1, now);
    if (key === '2' && this.state === ST.SELECT) this._beginLevel(2, now);
    if (key === '3' && this.state === ST.SELECT) this._beginLevel(3, now);
    if (key === ' ' && this.state === ST.INTRO) this._startPlay(now);
  }

  selectLevel(level, now) {
    if (this.state === ST.SELECT) this._beginLevel(level, now);
  }

  handleResultClick(x, y, now) {
    if (this.state !== ST.RESULT) return false;
    for (const [key, b] of Object.entries(this.resultButtonBounds)) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this._triggerResultButton(key, now);
        return true;
      }
    }
    return false;
  }

  _triggerResultButton(key, now) {
    if (key === 'again') {
      this._beginLevel(this.chosenLevel, now);
    } else if (key === 'menu') {
      this.state = ST.SELECT;
      this.hoverCard = -1;
      this.hoverStart = 0;
      this.resultHoverBtn = null;
      this.resultHoverStart = 0;
      this.trails.clear();
      this.handLastSeen.clear();
    }
  }

  // ── Tick ──────────────────────────────────────────────────────────────

  tick(now) {
    const dt = Math.min((now - (this._lastNow || now)), 1 / 30);
    this._lastNow = now;

    // Prune old trail points while keeping recently seen hand trails within grace window
    for (const [id, trail] of this.trails.entries()) {
      const filtered = trail.filter(p => now - p.t < TRAIL_MAX_AGE + 0.05);
      if (filtered.length > 0) {
        this.trails.set(id, filtered);
      } else {
        const lastSeen = this.handLastSeen.get(id) ?? -Infinity;
        if (id === 'pointer' || now - lastSeen > HAND_LOSS_GRACE) {
          this.trails.delete(id);
          this.handLastSeen.delete(id);
        } else {
          this.trails.set(id, []);
        }
      }
    }

    if (this.state === ST.SELECT) {
      this._tickSelect(now);
    } else if (this.state === ST.INTRO) {
      if (now - this.introStart >= INTRO_DUR) this._startPlay(now);
    } else if (this.state === ST.PLAYING) {
      this._tickPlay(dt, now);
    } else if (this.state === ST.RESULT) {
      this._tickResult(now);
    }

    // Prune popups
    this.popups = this.popups.filter(p => now - p.bornAt < p.dur);
    this.splashes = this.splashes.filter(s => now - s.bornAt < s.dur);
  }

  _findHoveredBound(bounds) {
    if (!bounds || Object.keys(bounds).length === 0) return null;
    for (const trail of this.trails.values()) {
      const last = trail[trail.length - 1];
      if (!last) continue;
      const { x: fx, y: fy } = last;
      for (const [key, b] of Object.entries(bounds)) {
        if (fx >= b.x && fx <= b.x + b.w && fy >= b.y && fy <= b.y + b.h) {
          return key;
        }
      }
    }
    return null;
  }

  _tickSelect(now) {
    const hitKey = this._findHoveredBound(this.cardBounds);
    const hit = hitKey !== null ? parseInt(hitKey) : -1;
    if (hit !== this.hoverCard) {
      this.hoverCard = hit;
      this.hoverStart = now;
    } else if (hit !== -1 && now - this.hoverStart >= SELECT_HOLD) {
      this._beginLevel(hit, now);
    }
  }

  _tickResult(now) {
    const hit = this._findHoveredBound(this.resultButtonBounds);
    if (hit !== this.resultHoverBtn) {
      this.resultHoverBtn = hit;
      this.resultHoverStart = now;
    } else if (hit !== null && now - this.resultHoverStart >= SELECT_HOLD) {
      this._triggerResultButton(hit, now);
    }
  }

  _tickPlay(dt, now) {
    const cfg = this.levelCfg;
    const elapsed = now - this.levelStart;
    const remaining = cfg.timeLimit - elapsed;

    if (remaining <= 0) { this._endGame(now); return; }
    if (this.lives <= 0) { this._endGame(now); return; }

    if (remaining <= 10 && !this.warned10) {
      this.warned10 = true;
      this._setPrompt('10 seconds left — slice faster!', now, 3.0);
    }
    if (remaining <= 5 && !this.warned5) {
      this.warned5 = true;
      this._setPrompt('HURRY! Last 5 seconds!', now, 5.0);
    }

    if (this.freezeActive && now >= this.freezeUntil) this.freezeActive = false;

    this._spawn(now);
    this._updateFruits(dt, now);
    this._detectSlices(now);
    this._checkLifeMilestone(now);
  }

  // ── Spawn ──────────────────────────────────────────────────────────────

  _spawn(now) {
    const interval = this.levelCfg.spawnInterval;
    while (now - this.lastSpawn >= interval) {
      this.fruits.push(spawnFruit(this.W, this.H, this.levelCfg));
      this.lastSpawn += interval;
      if (Math.random() < this.levelCfg.multiSpawnChance) {
        this.fruits.push(spawnFruit(this.W, this.H, this.levelCfg));
      }
    }
  }

  // ── Physics ────────────────────────────────────────────────────────────

  _updateFruits(dt, now) {
    const defaultG = this.levelCfg.gravity;
    const sf = this.freezeActive ? FREEZE_SPEED_FACTOR : 1.0;

    for (const f of this.fruits) {
      const g = f.gravity != null ? f.gravity : defaultG;
      if (f.slicedAt === null) {
        f.vy += g * dt * sf;
        f.x  += f.vx * dt * sf;
        f.y  += f.vy * dt * sf;
        f.rotation += f.rotationSpeed * dt * sf;
      } else {
        for (const hf of f.halves) {
          hf.vy += g * dt * sf;
          hf.x  += hf.vx * dt * sf;
          hf.y  += hf.vy * dt * sf;
          hf.angle += hf.spin * dt;
        }
        for (const p of f.particles) {
          p.vy += 400 * dt;
          p.x  += p.vx * dt;
          p.y  += p.vy * dt;
          p.life -= dt * 2.5;
        }
        f.particles = f.particles.filter(p => p.life > 0);
        if (now - f.slicedAt > 0.6) f.removed = true;
      }

      if (f.slicedAt === null && f.y - f.radius > this.H + 20) {
        f.removed = true;
        if (f.kind !== 'bomb' && f.kind !== 'freeze') {
          this._miss(now);
        }
      }
    }
    this.fruits = this.fruits.filter(f => !f.removed);
  }

  _miss(now) {
    this.lives = Math.max(0, this.lives - 1);
    this.combo = 1.0;
    this.comboChain = 0;
    if (this.lives <= 0) {
      this._endGame(now);
    } else {
      this._setPrompt(`Missed! ${this.lives} ${this.lives === 1 ? 'life' : 'lives'} left`, now, 1.8);
    }
  }

  // ── Slicing ────────────────────────────────────────────────────────────

  _detectSlices(now) {
    if (this.trails.size === 0) return;
    for (const fruit of this.fruits) {
      if (fruit.slicedAt !== null) continue;
      for (const trail of this.trails.values()) {
        let sliced = false;
        for (let i = 0; i < trail.length - 1; i++) {
          const p1 = trail[i], p2 = trail[i + 1];
          const elapsed = p2.t - p1.t;
          if (elapsed <= 0) continue;
          const distMoved = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          const speed = distMoved / elapsed;
          if (speed < this.levelCfg.sliceThreshold || distMoved < 15) continue;
          const dist = segmentDistance(fruit.x, fruit.y, p1.x, p1.y, p2.x, p2.y);
          if (dist <= fruit.radius * 0.92) {
            this._slice(fruit, now);
            sliced = true;
            break;
          }
        }
        if (sliced) break;
      }
    }
  }

  _slice(fruit, now) {
    markSliced(fruit, now);

    if (fruit.kind === 'freeze') {
      this.freezeActive = true;
      this.freezeUntil = now + FREEZE_DURATION;
      this._addPopup('FREEZE! ❄️', fruit.x, fruit.y, '#ffe066', 1.4);
      this._setPrompt('Freeze! All fruits slowed down', now, 2.5);
      this._addSplash(fruit.x, fruit.y, '#ffb300', 0.5);
      return;
    }

    if (fruit.kind === 'bomb') {
      this._addPopup('💥 BOMB! -1 LIFE', fruit.x, fruit.y, '#ff4444', 1.3);
      this._addSplash(fruit.x, fruit.y, '#ff2222', 0.5);
      this.combo = 1.0;
      this.comboChain = 0;
      this.lives = Math.max(0, this.lives - 1);
      if (this.lives <= 0) {
        this._endGame(now);
      } else {
        this._setPrompt(`Bomb hit! ${this.lives} ${this.lives === 1 ? 'life' : 'lives'} left`, now, 2.0);
      }
      return;
    }

    // Normal fruit
    const comboColor = fruit.isGolden ? '#00d4ff' : '#ffd700';
    if (now - this.lastSlice < COMBO_WINDOW) {
      this.combo = Math.min(MAX_COMBO, this.combo + 0.35);
      this.comboChain++;
    } else {
      this.combo = 1.0;
      this.comboChain = 1;
    }
    this.lastSlice = now;

    const mult = fruit.isGolden ? GOLDEN_FRUIT_MULTIPLIER : 1.0;
    const pts = Math.round(fruit.value * this.combo * mult);
    this.score += pts;
    this.bestScore = Math.max(this.bestScore, this.score);

    const label = fruit.isGolden ? `+${pts} ✨GOLDEN!` : `+${pts}`;
    this._addPopup(label, fruit.x, fruit.y, comboColor, 1.0);
    this._addSplash(fruit.x, fruit.y, fruit.isGolden ? '#00d4ff' : '#44cc44', 0.4);

    if (fruit.isGolden) this._setPrompt('Golden fruit — 3× points!', now, 1.5);

    if (this.comboChain >= 3) {
      this._addPopup(`${this.comboChain}× COMBO!`, fruit.x, fruit.y - 55, '#ff8800', 1.3);
      if (this.comboChain === 3) this._setPrompt('Combo! Keep slicing!', now, 1.5);
    }
  }

  _checkLifeMilestone(now) {
    const m = Math.floor(this.score / EXTRA_LIFE_SCORE);
    if (m > this.lastLifeMilestone) {
      this.lastLifeMilestone = m;
      this.lives++;
      this._addPopup('+1 LIFE! ❤️', this.W / 2, this.H / 2 - 60, '#80ff80', 1.8);
      this._setPrompt('Bonus life earned!', now, 2.0);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _addPopup(text, x, y, color, dur) {
    this.popups.push({ text, x, y, color, dur, bornAt: this._lastNow || 0 });
  }

  _addSplash(x, y, color, dur) {
    this.splashes.push({ x, y, color, dur, bornAt: this._lastNow || 0 });
  }

  _setPrompt(text, now, dur = 2.5) {
    this.prompt = text;
    this.promptUntil = now + dur;
  }

  _beginLevel(level, now) {
    this.chosenLevel = level;
    this.levelCfg = LEVELS[level];
    this.state = ST.INTRO;
    this.introStart = now;
    this.score = 0;
    this.lives = this.levelCfg.lives;
    this.combo = 1.0;
    this.comboChain = 0;
    this.lastSlice = 0;
    this.freezeActive = false;
    this.freezeUntil = 0;
    this.lastLifeMilestone = 0;
    this.warned10 = false;
    this.warned5 = false;
    this.fruits = [];
    this.popups = [];
    this.splashes = [];
    this.trails.clear();
    this.handLastSeen.clear();
    this.prompt = '';
    this.hoverCard = -1;
  }

  _startPlay(now) {
    this.state = ST.PLAYING;
    this.levelStart = now;
    this.lastSpawn = now;
    this._setPrompt('Swipe your index finger to slice fruit!', now, 3.5);
  }

  _endGame(now) {
    this.bestScore = Math.max(this.bestScore, this.score);
    this.state = ST.RESULT;
    this.resultPassed = this.score >= this.levelCfg.scoreTarget && this.lives > 0;
    this.resultReason = this.lives <= 0 ? "Out of lives!" : "Time's up!";
    this.resultHoverBtn = null;
    this.resultHoverStart = 0;
  }

  get timeRemaining() {
    if (this.state !== ST.PLAYING) return 0;
    return Math.max(0, this.levelCfg.timeLimit - (this._lastNow - this.levelStart));
  }

  get introProg() {
    if (this.state !== ST.INTRO) return 0;
    return Math.min(1, (this._lastNow - this.introStart) / INTRO_DUR);
  }

  get hoverProgress() {
    if (this.hoverCard === -1 || !this._lastNow) return 0;
    return Math.min(1, (this._lastNow - this.hoverStart) / SELECT_HOLD);
  }

  get resultHoverProgress() {
    if (!this.resultHoverBtn || !this._lastNow) return 0;
    return Math.min(1, (this._lastNow - this.resultHoverStart) / SELECT_HOLD);
  }
}
