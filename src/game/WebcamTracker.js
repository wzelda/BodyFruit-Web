// WebcamTracker.js — MediaPipe Tasks Vision hand tracking
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { HAND_LOSS_GRACE } from '../utils/constants.js';

// Middle finger MCP (base) = landmark 9; wrist = 0 for far-distance blend
const TRACK_LANDMARK = 9;
const WRIST_LANDMARK = 0;
// Usable camera crop (was 60%; wider so large far-distance swipes stay on-canvas)
const CROP_MARGIN = 0.12; // keep outer 12% → map middle 76%
const CROP_SPAN = 1 - CROP_MARGIN * 2;
// Blend wrist into MCP when hand is small / far (reduces MCP flicker)
const FAR_BLEND_START = 0.08; // wrist↔MCP normalized distance
const FAR_BLEND_END = 0.04;

export class WebcamTracker {
  constructor() {
    this.handLandmarker = null;
    this.videoEl = null;
    this.stream = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.onFingers = null; // callback([{ id, x, y }, ...])
    this.slots = [
      this._newSlot(0),
      this._newSlot(1),
    ];
    this._ready = false;
    this._error = null;
  }

  _newSlot(id) {
    return {
      id,
      x: undefined,
      y: undefined,
      vx: 0,
      vy: 0,
      lastSeen: -Infinity,
      lastUpdate: -Infinity,
    };
  }

  get ready() { return this._ready; }
  get error() { return this._error; }

  async init(videoEl) {
    this.videoEl = videoEl;
    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.25,
        minHandPresenceConfidence: 0.25,
        minTrackingConfidence: 0.25,
      });

      await this._startCamera();
      this._ready = true;
    } catch (e) {
      this._error = e.message || 'Failed to initialise hand tracker';
      console.error('WebcamTracker init error:', e);
    }
  }

  async _startCamera() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60, min: 30 },
        facingMode: 'user',
      },
    });
    this.videoEl.srcObject = this.stream;
    this.videoEl.setAttribute('playsinline', '');
    await new Promise(res => { this.videoEl.onloadedmetadata = res; });
    await this.videoEl.play();
  }

  _mapToCanvas(nx, ny, canvasW, canvasH) {
    const camX = (nx - CROP_MARGIN) / CROP_SPAN;
    const camY = (ny - CROP_MARGIN) / CROP_SPAN;

    const videoW = this.videoEl.videoWidth || 1280;
    const videoH = this.videoEl.videoHeight || 720;
    const videoAspect = videoW / videoH;
    const canvasAspect = canvasW / canvasH;

    let x, y;
    if (canvasAspect > videoAspect) {
      const visualH = canvasW / videoAspect;
      const yOffset = (visualH - canvasH) / 2;
      x = (1 - camX) * canvasW;
      y = camY * visualH - yOffset;
    } else {
      const visualW = canvasH * videoAspect;
      const xOffset = (visualW - canvasW) / 2;
      x = (1 - camX) * visualW - xOffset;
      y = camY * canvasH;
    }
    return { x, y };
  }

  _handPoint(hand) {
    const mcp = hand[TRACK_LANDMARK];
    const wrist = hand[WRIST_LANDMARK];
    // Smaller wrist↔MCP span ⇒ hand farther / smaller in frame ⇒ blend toward wrist
    const span = Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y);
    let w = 0;
    if (span < FAR_BLEND_START) {
      w = Math.min(1, (FAR_BLEND_START - span) / (FAR_BLEND_START - FAR_BLEND_END));
    }
    // Keep MCP dominant; wrist only stabilizes when far
    const blend = w * 0.35;
    return {
      x: mcp.x * (1 - blend) + wrist.x * blend,
      y: mcp.y * (1 - blend) + wrist.y * blend,
    };
  }

  _coastActive(nowSec) {
    const active = [];
    for (const slot of this.slots) {
      if (slot.x === undefined) continue;
      const age = nowSec - slot.lastSeen;
      if (age > HAND_LOSS_GRACE) {
        slot.x = undefined;
        slot.y = undefined;
        slot.vx = 0;
        slot.vy = 0;
        continue;
      }
      // Short ballistic coast so trail stays continuous across brief MediaPipe drops
      const dt = Math.min(nowSec - slot.lastUpdate, 1 / 30);
      if (dt > 0 && age > 0) {
        const decay = Math.max(0, 1 - age / HAND_LOSS_GRACE);
        slot.x += slot.vx * dt * decay;
        slot.y += slot.vy * dt * decay;
        slot.lastUpdate = nowSec;
      }
      active.push({ id: slot.id, x: slot.x, y: slot.y });
    }
    return active;
  }

  // Call this every animation frame
  detect(canvasW, canvasH) {
    if (!this.handLandmarker || !this.videoEl || this.videoEl.readyState < 2) {
      if (this.onFingers) this.onFingers([]);
      return;
    }
    const nowMs = performance.now();
    const nowSec = nowMs / 1000;
    if (this.videoEl.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.videoEl.currentTime;

    const result = this.handLandmarker.detectForVideo(this.videoEl, nowMs);

    if (result.landmarks && result.landmarks.length > 0) {
      const rawPoints = result.landmarks.map(hand => {
        const pt = this._handPoint(hand);
        return this._mapToCanvas(pt.x, pt.y, canvasW, canvasH);
      });

      // Match detected hands to existing active slots by nearest neighbor
      // Wider match radius so large swipes after a brief drop rematch the same slot
      const maxMatchDist = Math.max(canvasW, canvasH) * 0.85;
      const usedSlots = new Set();
      const assignments = new Array(rawPoints.length).fill(-1);

      const pairs = [];
      for (let p = 0; p < rawPoints.length; p++) {
        for (let s = 0; s < this.slots.length; s++) {
          const slot = this.slots[s];
          if (slot.x === undefined) continue;
          const d = Math.hypot(rawPoints[p].x - slot.x, rawPoints[p].y - slot.y);
          if (d <= maxMatchDist) {
            pairs.push({ p, s, d });
          }
        }
      }
      pairs.sort((a, b) => a.d - b.d);

      for (const { p, s } of pairs) {
        if (assignments[p] === -1 && !usedSlots.has(s)) {
          assignments[p] = s;
          usedSlots.add(s);
        }
      }

      // Assign any unmatched points to free slots
      for (let p = 0; p < rawPoints.length; p++) {
        if (assignments[p] !== -1) continue;
        const freeIdx = this.slots.findIndex((_, s) => !usedSlots.has(s));
        if (freeIdx !== -1) {
          assignments[p] = freeIdx;
          usedSlots.add(freeIdx);
        }
      }

      const activeFingers = [];
      const claimed = new Set();

      for (let p = 0; p < rawPoints.length; p++) {
        const s = assignments[p];
        if (s === -1) continue;
        claimed.add(s);
        const slot = this.slots[s];
        let { x, y } = rawPoints[p];

        const prevX = slot.x;
        const prevY = slot.y;
        const dt = nowSec - slot.lastUpdate;

        if (prevX !== undefined) {
          // After a detection gap, bridge from last coasted sample → new hit (ordered timestamps)
          const gap = nowSec - slot.lastUpdate;
          if (gap > 0.04 && gap < HAND_LOSS_GRACE) {
            const steps = Math.min(4, Math.max(1, Math.round(gap / 0.03)));
            for (let i = 1; i <= steps; i++) {
              const u = i / (steps + 1);
              activeFingers.push({
                id: slot.id,
                x: prevX + (x - prevX) * u,
                y: prevY + (y - prevY) * u,
                t: slot.lastUpdate + gap * u,
              });
            }
          }

          // Adaptive EMA: smooth jitter when slow, minimize lag on fast wide swipes
          const dist = Math.hypot(x - prevX, y - prevY);
          const alpha = dist < 30
            ? 0.5
            : Math.min(0.95, 0.5 + ((dist - 30) / 120) * 0.45);
          x = prevX + alpha * (x - prevX);
          y = prevY + alpha * (y - prevY);

          if (dt > 0 && dt < 0.2) {
            const nvx = (x - prevX) / dt;
            const nvy = (y - prevY) / dt;
            slot.vx = slot.vx * 0.35 + nvx * 0.65;
            slot.vy = slot.vy * 0.35 + nvy * 0.65;
          }
        }

        slot.x = x;
        slot.y = y;
        slot.lastSeen = nowSec;
        slot.lastUpdate = nowSec;
        activeFingers.push({ id: slot.id, x, y });
      }

      // Keep coasting unmatched slots still within grace (one hand dropped briefly)
      for (const slot of this.slots) {
        if (claimed.has(slot.id) || slot.x === undefined) continue;
        if (nowSec - slot.lastSeen > HAND_LOSS_GRACE) {
          slot.x = undefined;
          slot.y = undefined;
          slot.vx = 0;
          slot.vy = 0;
          continue;
        }
        const dt = Math.min(nowSec - slot.lastUpdate, 1 / 30);
        if (dt > 0) {
          const age = nowSec - slot.lastSeen;
          const decay = Math.max(0, 1 - age / HAND_LOSS_GRACE);
          slot.x += slot.vx * dt * decay;
          slot.y += slot.vy * dt * decay;
          slot.lastUpdate = nowSec;
        }
        activeFingers.push({ id: slot.id, x: slot.x, y: slot.y });
      }

      if (this.onFingers) this.onFingers(activeFingers);
    } else {
      // No hands this frame — coast instead of clearing immediately
      const coasted = this._coastActive(nowSec);
      if (this.onFingers) this.onFingers(coasted);
    }
  }

  stop() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.handLandmarker) {
      this.handLandmarker.close();
      this.handLandmarker = null;
    }
    this._ready = false;
  }
}
