/**
 * HUD, debug overlay and the settings panel.
 *
 * Plain DOM rather than in-engine drawing: it costs no frame time, it is
 * readable at any resolution scale, and it keeps the renderer free of text
 * layout code.
 */

import { HOTBAR_SLOTS } from '../world/blocks.ts';
import { BIOMES } from '../world/biomes.ts';
import type { Settings, PresetName } from '../core/settings.ts';
import { presetSettings } from '../core/settings.ts';
import type { Inventory } from '../game/inventory.ts';
import { itemDef } from '../game/items.ts';
import type { IconSet } from './icons.ts';

export interface HudCallbacks {
  onSettingsChange(settings: Settings, preset: PresetName): void;
}

/** Bubbles in the breath meter. Coarse on purpose; see `updateBreath`. */
const BREATH_BUBBLES = 10;

export class Hud {
  private readonly hotbarEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly settingsEl: HTMLElement;
  private readonly crosshairEl: HTMLElement;
  private readonly hudEl: HTMLElement;
  private readonly breathEl: HTMLElement;

  private readonly heldLabelEl: HTMLElement;
  private readonly healthEl: HTMLElement;
  private readonly armourEl: HTMLElement;
  private armourPips: HTMLElement[] = [];
  private shownArmour = -1;
  private readonly hungerEl: HTMLElement;
  private hungerPips: HTMLElement[] = [];
  private shownHunger = -1;
  private readonly flashEl: HTMLElement;
  private readonly deathEl: HTMLElement;
  private readonly deathCauseEl: HTMLElement;

  private hearts: HTMLElement[] = [];
  private shownHealth = -1;
  /** Seconds left on the red flash. */
  private flashTimer = 0;

  private slots: HTMLElement[] = [];
  private activeSlot = -1;
  /** Last inventory version painted into the hotbar. */
  private hotbarVersion = -1;
  /** Seconds left on the "what am I holding" label. */
  private heldLabelTimer = 0;
  private heldLabelText = '';

  private bubbles: HTMLElement[] = [];
  private bubblesLeft = -1;
  private breathHidden = true;

  private statsVisible = false;
  private settingsVisible = false;

  private frameSamples: number[] = [];
  private lastStatsUpdate = 0;

  private settings: Settings;
  private preset: PresetName;

  constructor(
    settings: Settings,
    preset: PresetName,
    private readonly inventory: Inventory,
    private readonly icons: IconSet,
    private readonly callbacks: HudCallbacks,
  ) {
    this.settings = { ...settings };
    this.preset = preset;

    this.hotbarEl = document.getElementById('hotbar')!;
    this.statsEl = document.getElementById('stats')!;
    this.settingsEl = document.getElementById('settings')!;
    this.crosshairEl = document.getElementById('crosshair')!;
    this.hudEl = document.getElementById('hud')!;
    this.breathEl = document.getElementById('breath')!;

    this.heldLabelEl = document.createElement('div');
    this.heldLabelEl.id = 'held-label';
    this.heldLabelEl.hidden = true;
    this.hudEl.insertBefore(this.heldLabelEl, this.hotbarEl);

    this.healthEl = document.getElementById('health')!;

    // Armour sits on its own row above the hearts, and disappears when there
    // is none: an empty bar that never fills is furniture.
    this.armourEl = document.createElement('div');
    this.armourEl.id = 'armour';
    this.armourEl.hidden = true;
    this.hudEl.insertBefore(this.armourEl, this.healthEl);

    // Hunger goes under the hearts, and unlike armour it is always on screen:
    // the whole point of it is that the player watches it fall.
    this.hungerEl = document.createElement('div');
    this.hungerEl.id = 'hunger';
    this.hudEl.insertBefore(this.hungerEl, this.breathEl);

    // A red wash over the whole screen when something bites. Done in the DOM
    // rather than in the composite shader on purpose: it is interface, not
    // scene, and it costs the renderer nothing.
    this.flashEl = document.createElement('div');
    this.flashEl.id = 'hurt-flash';
    document.body.appendChild(this.flashEl);

    this.deathEl = document.createElement('div');
    this.deathEl.id = 'death';
    this.deathEl.hidden = true;
    const deathPanel = document.createElement('div');
    deathPanel.className = 'death-panel';
    const title = document.createElement('h2');
    title.textContent = 'Вы погибли';
    this.deathCauseEl = document.createElement('p');
    const button = document.createElement('button');
    button.id = 'respawn';
    button.textContent = 'Возродиться';
    deathPanel.append(title, this.deathCauseEl, button);
    this.deathEl.appendChild(deathPanel);
    document.body.appendChild(this.deathEl);

    this.buildHotbar();
    this.buildHearts();
    this.buildArmour();
    this.buildHunger();
    this.buildSettings();
  }

  private buildHearts(): void {
    this.healthEl.textContent = '';
    this.hearts = [];
    // Ten hearts of two half-hearts each, exactly as the reference splits them.
    for (let i = 0; i < 10; i++) {
      const heart = document.createElement('div');
      heart.className = 'heart';
      this.healthEl.appendChild(heart);
      this.hearts.push(heart);
    }
  }

  private buildArmour(): void {
    this.armourEl.textContent = '';
    this.armourPips = [];
    // Ten pips for twenty points, like the hearts: one pip is two points.
    for (let i = 0; i < 10; i++) {
      const pip = document.createElement('div');
      pip.className = 'pip';
      this.armourEl.appendChild(pip);
      this.armourPips.push(pip);
    }
  }

  /** Paints the armour row, hiding it entirely when nothing is worn. */
  updateArmour(points: number): void {
    if (points === this.shownArmour) return;
    this.shownArmour = points;
    this.armourEl.hidden = points <= 0;
    if (points <= 0) return;
    for (let i = 0; i < this.armourPips.length; i++) {
      const filled = points - i * 2;
      this.armourPips[i].classList.toggle('full', filled >= 2);
      this.armourPips[i].classList.toggle('half', filled === 1);
    }
  }

  private buildHunger(): void {
    this.hungerEl.textContent = '';
    this.hungerPips = [];
    for (let i = 0; i < 10; i++) {
      const pip = document.createElement('div');
      pip.className = 'bite';
      this.hungerEl.appendChild(pip);
      this.hungerPips.push(pip);
    }
  }

  /** Paints the hunger row. Ten pips of two points, like the hearts. */
  updateHunger(points: number): void {
    if (points === this.shownHunger) return;
    this.shownHunger = points;
    for (let i = 0; i < this.hungerPips.length; i++) {
      const filled = points - i * 2;
      this.hungerPips[i].classList.toggle('full', filled >= 2);
      this.hungerPips[i].classList.toggle('half', filled === 1);
    }
    this.hungerEl.classList.toggle('low', points <= 6);
  }

  /** Called when the player is hurt: flashes the screen. */
  showHurt(): void {
    this.flashTimer = 0.45;
    this.flashEl.style.opacity = '1';
  }

  /**
   * Paints the hearts.
   *
   * `health` is in half-hearts, 0..20. Half-hearts matter: the difference
   * between one heart and half of one is the difference between surviving the
   * next fall and not.
   */
  updateHealth(health: number, dt: number): void {
    if (health !== this.shownHealth) {
      this.shownHealth = health;
      for (let i = 0; i < this.hearts.length; i++) {
        const filled = health - i * 2;
        this.hearts[i].classList.toggle('full', filled >= 2);
        this.hearts[i].classList.toggle('half', filled === 1);
        this.hearts[i].classList.toggle('empty', filled <= 0);
      }
      this.healthEl.classList.toggle('low', health <= 6);
    }

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.flashEl.style.opacity = String(Math.max(0, this.flashTimer / 0.45) * 0.55);
    }
  }

  /** Shows the death panel; `onRespawn` is wired once by the caller. */
  showDeath(cause: string, onRespawn: () => void): void {
    if (!this.deathEl.hidden) return;
    this.deathCauseEl.textContent = cause;
    this.deathEl.hidden = false;
    const button = this.deathEl.querySelector('#respawn') as HTMLButtonElement;
    button.onclick = onRespawn;
    button.focus();
  }

  hideDeath(): void {
    this.deathEl.hidden = true;
  }

  get deathVisible(): boolean {
    return !this.deathEl.hidden;
  }

  private buildHotbar(): void {
    this.hotbarEl.textContent = '';
    this.slots = [];
    for (let index = 0; index < HOTBAR_SLOTS; index++) {
      const slot = document.createElement('div');
      slot.className = 'slot';

      const icon = document.createElement('div');
      icon.className = 'icon';
      slot.appendChild(icon);

      const count = document.createElement('span');
      count.className = 'count';
      slot.appendChild(count);

      const key = document.createElement('span');
      key.className = 'digit';
      key.textContent = String(index + 1);
      slot.appendChild(key);

      const wear = document.createElement('div');
      wear.className = 'wear';
      wear.hidden = true;
      slot.appendChild(wear);

      this.hotbarEl.appendChild(slot);
      this.slots.push(slot);
    }
  }

  /**
   * Repaints the hotbar from the bag, and only when the bag changed.
   *
   * Called every frame; the version check is what keeps it from rebuilding nine
   * slots sixty times a second while nothing happens.
   */
  updateHotbar(dt: number): void {
    if (this.inventory.version !== this.hotbarVersion) {
      this.hotbarVersion = this.inventory.version;
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        const item = this.inventory.get(i);
        const icon = slot.querySelector('.icon') as HTMLElement;
        const count = slot.querySelector('.count') as HTMLElement;
        const wear = slot.querySelector('.wear') as HTMLElement;

        if (!item) {
          icon.style.backgroundImage = '';
          count.textContent = '';
          wear.hidden = true;
          slot.title = '';
          continue;
        }

        const def = itemDef(item.id);
        icon.style.backgroundImage = `url(${this.icons.urls[item.id] ?? ''})`;
        count.textContent = item.count > 1 ? String(item.count) : '';
        slot.title = def.label;

        if (def.durability > 0 && item.damage > 0) {
          const left = Math.max(0, 1 - item.damage / def.durability);
          wear.hidden = false;
          wear.style.width = `${left * 100}%`;
          wear.style.background = `hsl(${Math.round(left * 110)}, 85%, 45%)`;
        } else {
          wear.hidden = true;
        }
      }
    }

    if (this.heldLabelTimer > 0) {
      this.heldLabelTimer -= dt;
      if (this.heldLabelTimer <= 0) this.heldLabelEl.hidden = true;
    }
  }

  /** Names what just came into hand, the way the reference does on a slot change. */
  showHeldLabel(): void {
    const held = this.inventory.held;
    const text = held ? itemDef(held.id).label : '';
    if (!text) {
      this.heldLabelEl.hidden = true;
      this.heldLabelTimer = 0;
      return;
    }
    if (text !== this.heldLabelText) {
      this.heldLabelText = text;
      this.heldLabelEl.textContent = text;
    }
    this.heldLabelEl.hidden = false;
    this.heldLabelTimer = 2;
  }

  setPlaying(playing: boolean): void {
    this.crosshairEl.hidden = !playing;
    this.hudEl.hidden = !playing;
    document.body.classList.toggle('playing', playing);
  }

  /**
   * Hides the on-screen hotbar while a window is open.
   *
   * The window carries its own copy of the hotbar row — that is what makes
   * dragging things into it possible — and showing both at once reads as two
   * hotbars that disagree.
   */
  setWindowOpen(open: boolean): void {
    this.hudEl.hidden = open;
    this.crosshairEl.hidden = open;
  }

  setHotbarIndex(index: number): void {
    if (index === this.activeSlot) return;
    this.slots[this.activeSlot]?.classList.remove('active');
    this.slots[index]?.classList.add('active');
    this.activeSlot = index;
    this.showHeldLabel();
  }

  toggleStats(): void {
    this.statsVisible = !this.statsVisible;
    this.statsEl.hidden = !this.statsVisible;
  }

  toggleSettings(): void {
    this.settingsVisible = !this.settingsVisible;
    this.settingsEl.hidden = !this.settingsVisible;
  }

  get settingsOpen(): boolean {
    return this.settingsVisible;
  }

  /**
   * Shows the breath meter while it means something.
   *
   * `breath` is 1 when full. The row appears the moment it starts draining and
   * stays until it is full again, so surfacing gives visible confirmation that
   * it is refilling rather than just making the indicator vanish.
   */
  updateBreath(breath: number): void {
    const spent = breath >= 0.999;
    if (spent !== this.breathHidden) {
      this.breathHidden = spent;
      this.breathEl.hidden = spent;
    }
    if (spent) return;

    if (this.bubbles.length === 0) {
      for (let i = 0; i < BREATH_BUBBLES; i++) {
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        this.breathEl.appendChild(bubble);
        this.bubbles.push(bubble);
      }
    }

    // Ceil, so the last sliver of air still shows one bubble: an empty row and
    // an almost-empty row must not look the same.
    const left = Math.ceil(breath * BREATH_BUBBLES);
    if (left !== this.bubblesLeft) {
      this.bubblesLeft = left;
      for (let i = 0; i < BREATH_BUBBLES; i++) {
        this.bubbles[i].classList.toggle('spent', i >= left);
      }
      this.breathEl.classList.toggle('low', left <= 3);
    }
  }

  // -------------------------------------------------------------------------
  // Debug overlay
  // -------------------------------------------------------------------------

  recordFrame(deltaMs: number): void {
    this.frameSamples.push(deltaMs);
    if (this.frameSamples.length > 120) this.frameSamples.shift();
  }

  updateStats(info: {
    now: number;
    position: Float32Array;
    biome: number;
    clock: string;
    rain: number;
    wind: number;
    world: { columns: number; generated: number; lit: number; pendingJobs: number; workers: number; shared: boolean; giBakeMs: number; savedEdits: number };
    render: { drawCalls: number; visibleQuads: number; totalQuads: number; sections: number; shadowDraws: number; internalWidth: number; internalHeight: number };
    renderer: string;
    facing: string;
  }): void {
    if (!this.statsVisible) return;
    // Refresh at 5 Hz: the numbers are unreadable faster than that, and the
    // string building is not free.
    if (info.now - this.lastStatsUpdate < 200) return;
    this.lastStatsUpdate = info.now;

    const samples = this.frameSamples;
    const count = samples.length || 1;
    let sum = 0;
    let worst = 0;
    for (const s of samples) {
      sum += s;
      if (s > worst) worst = s;
    }
    const average = sum / count;

    // 1% low, the number that actually reflects stutter.
    const sorted = [...samples].sort((a, b) => b - a);
    const onePercentLow = sorted.length > 0
      ? 1000 / sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.01))]
      : 0;

    const w = info.world;
    const r = info.render;

    const lines = [
      `SUPERGRAPH · ${info.renderer.slice(0, 44)}`,
      '',
      `fps   ${(1000 / average).toFixed(0).padStart(4)}   ` +
        `${average.toFixed(2).padStart(6)} ms   ` +
        `worst ${worst.toFixed(1)} ms   1%low ${onePercentLow.toFixed(0)}`,
      `res   ${r.internalWidth}x${r.internalHeight}`,
      '',
      `xyz   ${info.position[0].toFixed(2)} / ${info.position[1].toFixed(2)} / ${info.position[2].toFixed(2)}`,
      `chunk ${Math.floor(info.position[0]) >> 5} ${Math.floor(info.position[2]) >> 5}   facing ${info.facing}`,
      `biome ${BIOMES[info.biome]?.name ?? '—'}`,
      `time  ${info.clock}   дождь ${(info.rain * 100).toFixed(0)}%   ветер ${info.wind.toFixed(2)}`,
      '',
      `draws ${r.drawCalls}  (+${r.shadowDraws} тени)`,
      `quads ${(r.visibleQuads / 1000).toFixed(1)}k видимо / ${(r.totalQuads / 1000).toFixed(1)}k всего`,
      `секц. ${r.sections}`,
      '',
      `чанки ${w.lit}/${w.generated}/${w.columns} (свет/ген/всего)`,
      `очередь ${w.pendingJobs}   воркеры ${w.workers}   SAB ${w.shared ? 'да' : 'нет'}`,
      `непрямой свет ${w.giBakeMs > 0 ? `${w.giBakeMs.toFixed(0)} мс на выпечку` : 'выкл'}`,
      `сохранено ${w.savedEdits} правок`,
    ];

    this.statsEl.textContent = lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Settings panel
  // -------------------------------------------------------------------------

  private buildSettings(): void {
    this.settingsEl.textContent = '';

    const title = document.createElement('h2');
    title.textContent = 'Настройки графики';
    this.settingsEl.appendChild(title);

    const presets = document.createElement('div');
    presets.className = 'presets';
    const presetNames: PresetName[] = ['low', 'medium', 'high', 'ultra'];
    // Named for what they are for rather than where they sit on a ladder: the
    // middle two are the two profiles the engine is actually tuned around.
    const presetLabels: Record<PresetName, string> = {
      low: 'Слабый', medium: 'Плавно', high: 'Красиво', ultra: 'Скриншот',
    };

    const presetButtons = presetNames.map((name) => {
      const button = document.createElement('button');
      button.textContent = presetLabels[name];
      button.classList.toggle('active', name === this.preset);
      button.addEventListener('click', () => {
        this.preset = name;
        this.settings = presetSettings(name);
        for (const [i, b] of presetButtons.entries()) {
          b.classList.toggle('active', presetNames[i] === name);
        }
        this.buildSettings();
        this.emit();
      });
      presets.appendChild(button);
      return button;
    });
    this.settingsEl.appendChild(presets);

    this.addSectionTitle('Мир');
    this.addSlider('Дальность прорисовки', 'renderDistance', 3, 16, 1, (v) => `${v} чанк.`);
    this.addSlider('Масштаб рендера', 'resolutionScale', 0.5, 1.25, 0.05, (v) => `${Math.round(v * 100)}%`);
    this.addSlider('Поле зрения', 'fovDegrees', 60, 110, 1, (v) => `${v}°`);

    this.addSectionTitle('Освещение');
    this.addToggle('Тени', 'shadowsEnabled');
    this.addSlider('Каскады', 'shadowCascades', 1, 4, 1, (v) => String(v));
    this.addSlider('Дальность теней', 'shadowDistance', 48, 320, 8, (v) => `${v} бл.`);
    this.addSlider('Качество фильтра', 'shadowFilter', 1, 3, 1, (v) => String(v));
    this.addToggle('SSAO', 'ssaoEnabled');

    this.addToggle('Непрямой свет', 'giEnabled');
    this.addSlider('Сила непрямого', 'giStrength', 0, 2, 0.1, (v) => v.toFixed(1));

    this.addSectionTitle('Рельеф поверхности');
    this.addSlider('Сила нормалей', 'surfaceDetail', 0, 1, 0.05, (v) => v.toFixed(2));
    this.addToggle('Параллакс', 'parallaxEnabled');
    this.addSlider('Шаги параллакса', 'parallaxSteps', 4, 48, 4, (v) => String(v));
    this.addSlider('Глубина рельефа', 'parallaxDepth', 0.01, 0.1, 0.005, (v) => v.toFixed(3));
    this.addSlider('Дальность рельефа', 'parallaxDistance', 6, 40, 2, (v) => `${v} бл.`);
    this.addToggle('Самозатенение рельефа', 'parallaxShadows');

    this.addSectionTitle('Небо и вода');
    this.addSlider('Шаги неба', 'skyViewSteps', 8, 48, 4, (v) => String(v));
    this.addToggle('Объёмные лучи', 'lightShafts');
    this.addSlider('Сила лучей', 'lightShaftStrength', 0, 1.5, 0.1, (v) => v.toFixed(1));
    this.addSlider('Шаги облаков', 'cloudSteps', 0, 64, 4, (v) => (v === 0 ? 'выкл' : String(v)));
    this.addSlider('Облачность', 'cloudCoverage', 0, 0.9, 0.05, (v) => `${Math.round(v * 100)}%`);
    this.addToggle('Отражения воды', 'waterReflections');
    this.addSlider('Шаги SSR', 'ssrSteps', 0, 48, 4, (v) => (v === 0 ? 'выкл' : String(v)));
    this.addToggle('Отражения на мокром', 'wetReflections');

    this.addSectionTitle('Растительность');
    this.addToggle('Трава', 'grassEnabled');
    this.addSlider('Дальность травы', 'grassDistance', 12, 80, 4, (v) => `${v} бл.`);
    this.addSlider('Плотность травы', 'grassDensity', 0.25, 2, 0.25, (v) => `${v}x`);

    this.addSectionTitle('Звук');
    this.addSlider('Громкость', 'audioVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);

    this.addSectionTitle('Пост-обработка');
    this.addToggle('TAA', 'taaEnabled');
    this.addToggle('Bloom', 'bloomEnabled');
    this.addSlider('Экспозиция', 'exposure', 0.3, 2.5, 0.05, (v) => v.toFixed(2));
    this.addSlider('Виньетка', 'vignette', 0, 1, 0.05, (v) => v.toFixed(2));
    this.addSlider('Хром. аберрация', 'chromaticAberration', 0, 1, 0.05, (v) => v.toFixed(2));
    this.addSlider('Зерно', 'filmGrain', 0, 0.1, 0.005, (v) => v.toFixed(3));
  }

  private addSectionTitle(text: string): void {
    const el = document.createElement('div');
    el.className = 'section-title';
    el.textContent = text;
    this.settingsEl.appendChild(el);
  }

  private addSlider<K extends keyof Settings>(
    label: string,
    key: K,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
  ): void {
    const current = this.settings[key];
    if (typeof current !== 'number') return;

    const row = document.createElement('div');
    row.className = 'row';

    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const valueEl = document.createElement('span');
    valueEl.className = 'value';
    valueEl.textContent = format(current);
    row.appendChild(valueEl);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(current);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      (this.settings[key] as number) = value;
      valueEl.textContent = format(value);
    });
    // Only commit on release: rebuilding shaders on every drag frame would
    // stall the renderer.
    input.addEventListener('change', () => this.emit());
    row.appendChild(input);

    this.settingsEl.appendChild(row);
  }

  private addToggle<K extends keyof Settings>(label: string, key: K): void {
    const current = this.settings[key];
    if (typeof current !== 'boolean') return;

    const row = document.createElement('div');
    row.className = 'row';

    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = current;
    input.addEventListener('change', () => {
      (this.settings[key] as boolean) = input.checked;
      this.emit();
    });
    row.appendChild(input);

    this.settingsEl.appendChild(row);
  }

  private emit(): void {
    this.callbacks.onSettingsChange({ ...this.settings }, this.preset);
  }
}

/** Compass label for the debug overlay. */
export function facingLabel(yaw: number): string {
  const normalized = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const octant = Math.round(normalized / (Math.PI / 4)) % 8;
  return ['юг', 'юго-восток', 'восток', 'северо-восток', 'север', 'северо-запад', 'запад', 'юго-запад'][octant];
}
